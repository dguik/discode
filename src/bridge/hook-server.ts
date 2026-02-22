import { createServer } from 'http';
import { parse } from 'url';
import { existsSync, realpathSync } from 'fs';
import { resolve } from 'path';
import { splitForDiscord, splitForSlack, extractFilePaths, stripFilePaths } from '../capture/parser.js';
import type { MessagingClient } from '../messaging/interface.js';
import type { IStateManager } from '../types/interfaces.js';
import type { AgentRuntime } from '../runtime/interface.js';
import { RuntimeControlPlane } from '../runtime/control-plane.js';
import { agentRegistry } from '../agents/index.js';
import { installAgentIntegration } from '../policy/agent-integration.js';
import { buildAgentLaunchEnv, buildExportPrefix, withClaudePluginDir } from '../policy/agent-launch.js';
import {
  getPrimaryInstanceForAgent,
  getProjectInstance,
  listProjectInstances,
  normalizeProjectState,
} from '../state/instances.js';
import { PendingMessageTracker } from './pending-message-tracker.js';
import type { PendingEntry } from './pending-message-tracker.js';
import type { StreamingMessageUpdater } from './streaming-message-updater.js';

export interface BridgeHookServerDeps {
  port: number;
  messaging: MessagingClient;
  stateManager: IStateManager;
  pendingTracker: PendingMessageTracker;
  streamingUpdater: StreamingMessageUpdater;
  reloadChannelMappings: () => void;
  runtime?: AgentRuntime;
}

/** Shared context passed to individual event handlers after common validation. */
interface EventContext {
  event: Record<string, unknown>;
  projectName: string;
  channelId: string;
  /** Resolved agent type (from instance or event payload). */
  agentType: string;
  /** Resolved instance ID, if available. */
  instanceId: string | undefined;
  /** Key for streaming updater: instanceId ?? agentType. */
  instanceKey: string;
  text: string | undefined;
  /** Resolved, absolute project path (empty string if unavailable). */
  projectPath: string;
  /**
   * Snapshot of the pending entry captured at event arrival time.
   * Prevents race conditions where markPending for a NEWER request overwrites
   * the active pending while the current handler is queued/running.
   */
  pendingSnapshot: PendingEntry | undefined;
}

type StatusResult = { status: number; message: string };
type HttpRes = { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body: string) => void };

export class BridgeHookServer {
  private httpServer?: ReturnType<typeof createServer>;
  private runtimeControl: RuntimeControlPlane;

  /** Per-channel event queue to serialize message delivery (prevents simultaneous prompt messages). */
  private channelQueues = new Map<string, Promise<void>>();

  /** Periodic timers that show elapsed thinking time in the streaming message. */
  private thinkingTimers = new Map<string, { timer: ReturnType<typeof setInterval>; startTime: number }>();

  /** Thread activity messages (one message per instance, replaced with latest activity). */
  private threadActivityMessages = new Map<string, { channelId: string; parentMessageId: string; messageId: string; lines: string[] }>();

  /** Session lifecycle timers — resolve pending after delay if no AI activity starts (local commands like /model). */
  private sessionLifecycleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private static readonly THINKING_INTERVAL_MS = 10_000;
  private static readonly SESSION_LIFECYCLE_DELAY_MS = 5_000;

  private static readonly MAX_BODY_BYTES = 256 * 1024;

  private eventHandlers: Record<string, (ctx: EventContext) => Promise<boolean>> = {
    'session.error': (ctx) => this.handleSessionError(ctx),
    'session.notification': (ctx) => this.handleSessionNotification(ctx),
    'session.start': (ctx) => this.handleSessionStart(ctx),
    'session.end': (ctx) => this.handleSessionEnd(ctx),
    'thinking.start': (ctx) => this.handleThinkingStart(ctx),
    'thinking.stop': (ctx) => this.handleThinkingStop(ctx),
    'tool.activity': (ctx) => this.handleToolActivity(ctx),
    'session.idle': (ctx) => this.handleSessionIdle(ctx),
  };

  private statusRoutes: Record<string, (payload: unknown) => StatusResult | Promise<StatusResult>> = {
    '/runtime/focus': (p) => this.handleRuntimeFocus(p),
    '/runtime/input': (p) => this.handleRuntimeInput(p),
    '/runtime/stop': (p) => this.handleRuntimeStop(p),
    '/runtime/ensure': (p) => this.handleRuntimeEnsure(p),
    '/send-files': (p) => this.handleSendFiles(p),
  };

  constructor(private deps: BridgeHookServerDeps) {
    this.runtimeControl = new RuntimeControlPlane(deps.runtime);
  }

  start(): void {
    this.httpServer = createServer(async (req, res) => {
      const parsed = parse(req.url || '', true);
      const pathname = parsed.pathname;

      if (req.method === 'GET' && pathname === '/runtime/windows') {
        this.handleRuntimeWindows(res);
        return;
      }

      if (req.method === 'GET' && pathname === '/runtime/buffer') {
        const windowId = this.readQueryString(parsed.query.windowId);
        const sinceRaw = this.readQueryString(parsed.query.since);
        const since = sinceRaw ? parseInt(sinceRaw, 10) : 0;
        this.handleRuntimeBuffer(res, windowId, Number.isFinite(since) ? since : 0);
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
      }

      let body = '';
      let aborted = false;
      req.on('data', (chunk) => {
        if (aborted) return;
        body += chunk.toString('utf8');
        if (body.length > BridgeHookServer.MAX_BODY_BYTES) {
          aborted = true;
          res.writeHead(413);
          res.end('Payload too large');
          req.destroy();
        }
      });
      req.on('end', () => {
        if (aborted) return;
        void (async () => {
          try {
            await this.dispatchPostRoute(pathname || '', body, res);
          } catch (error) {
            console.error('Request processing error:', error);
            res.writeHead(500);
            res.end('Internal error');
          }
        })();
      });
    });

    this.httpServer.on('error', (err) => {
      console.error('HTTP server error:', err);
    });

    this.httpServer.listen(this.deps.port, '127.0.0.1');
  }

  stop(): void {
    // Clear all thinking timers
    for (const [key] of this.thinkingTimers) {
      this.clearThinkingTimer(key);
    }
    // Clear all session lifecycle timers
    for (const timer of this.sessionLifecycleTimers.values()) {
      clearTimeout(timer);
    }
    this.sessionLifecycleTimers.clear();
    // Clear all thread activity tracking
    this.threadActivityMessages.clear();
    this.httpServer?.close();
    this.httpServer = undefined;
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  private writeJson(res: HttpRes, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  }

  private readQueryString(value: string | string[] | undefined): string | undefined {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length > 0) return value[0];
    return undefined;
  }

  private parseJsonBody(body: string, res: HttpRes): unknown | null {
    try {
      return body ? JSON.parse(body) : {};
    } catch {
      res.writeHead(400);
      res.end('Invalid JSON');
      return null;
    }
  }

  private async dispatchPostRoute(pathname: string, body: string, res: HttpRes): Promise<void> {
    if (pathname === '/reload') {
      this.deps.reloadChannelMappings();
      res.writeHead(200);
      res.end('OK');
      return;
    }

    const payload = this.parseJsonBody(body, res);
    if (payload === null) return;

    const statusHandler = this.statusRoutes[pathname];
    if (statusHandler) {
      const result = await statusHandler(payload);
      res.writeHead(result.status);
      res.end(result.message);
      return;
    }

    if (pathname === '/opencode-event') {
      const ok = await this.handleOpencodeEvent(payload);
      if (ok) {
        res.writeHead(200);
        res.end('OK');
      } else {
        res.writeHead(400);
        res.end('Invalid event payload');
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }

  // ---------------------------------------------------------------------------
  // Runtime control routes
  // ---------------------------------------------------------------------------

  private handleRuntimeWindows(res: HttpRes): void {
    if (!this.runtimeControl.isEnabled()) {
      this.writeJson(res, 501, { error: 'Runtime control unavailable' });
      return;
    }

    const result = this.runtimeControl.listWindows();
    this.writeJson(res, 200, result);
  }

  private handleRuntimeFocus(payload: unknown): StatusResult {
    if (!this.runtimeControl.isEnabled()) {
      return { status: 501, message: 'Runtime control unavailable' };
    }
    if (!payload || typeof payload !== 'object') {
      return { status: 400, message: 'Invalid payload' };
    }

    const windowId = typeof (payload as Record<string, unknown>).windowId === 'string'
      ? ((payload as Record<string, unknown>).windowId as string)
      : undefined;
    if (!windowId) {
      return { status: 400, message: 'Missing windowId' };
    }

    const focused = this.runtimeControl.focusWindow(windowId);
    if (!focused) {
      return { status: 404, message: 'Window not found' };
    }

    return { status: 200, message: 'OK' };
  }

  private handleRuntimeInput(payload: unknown): StatusResult {
    if (!this.runtimeControl.isEnabled()) {
      return { status: 501, message: 'Runtime control unavailable' };
    }
    if (!payload || typeof payload !== 'object') {
      return { status: 400, message: 'Invalid payload' };
    }

    const event = payload as Record<string, unknown>;
    const windowId = typeof event.windowId === 'string' ? event.windowId : undefined;
    const text = typeof event.text === 'string' ? event.text : undefined;
    const submit = typeof event.submit === 'boolean' ? event.submit : undefined;

    if (!windowId && !this.runtimeControl.getActiveWindowId()) {
      return { status: 400, message: 'Missing windowId' };
    }
    if (!text && submit === false) {
      return { status: 400, message: 'No input to send' };
    }

    try {
      this.runtimeControl.sendInput({ windowId, text, submit });
      return { status: 200, message: 'OK' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Window not found') || message.includes('Invalid windowId')) {
        return { status: 404, message: 'Window not found' };
      }
      return { status: 400, message };
    }
  }

  private handleRuntimeBuffer(res: HttpRes, windowId: string | undefined, since: number): void {
    if (!this.runtimeControl.isEnabled()) {
      this.writeJson(res, 501, { error: 'Runtime control unavailable' });
      return;
    }
    if (!windowId) {
      this.writeJson(res, 400, { error: 'Missing windowId' });
      return;
    }

    try {
      const result = this.runtimeControl.getBuffer(windowId, since);
      this.writeJson(res, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Window not found') || message.includes('Invalid windowId')) {
        this.writeJson(res, 404, { error: 'Window not found' });
        return;
      }
      this.writeJson(res, 400, { error: message });
    }
  }

  private handleRuntimeStop(payload: unknown): StatusResult {
    if (!this.runtimeControl.isEnabled()) {
      return { status: 501, message: 'Runtime control unavailable' };
    }
    if (!payload || typeof payload !== 'object') {
      return { status: 400, message: 'Invalid payload' };
    }

    const windowId = typeof (payload as Record<string, unknown>).windowId === 'string'
      ? ((payload as Record<string, unknown>).windowId as string)
      : undefined;
    if (!windowId) {
      return { status: 400, message: 'Missing windowId' };
    }

    try {
      this.runtimeControl.stopWindow(windowId);
      return { status: 200, message: 'OK' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Window not found') || message.includes('Invalid windowId')) {
        return { status: 404, message: 'Window not found' };
      }
      if (message.includes('Runtime stop unavailable')) {
        return { status: 501, message: 'Runtime stop unavailable' };
      }
      return { status: 400, message };
    }
  }

  private handleRuntimeEnsure(payload: unknown): StatusResult {
    if (!this.deps.runtime) {
      return { status: 501, message: 'Runtime control unavailable' };
    }
    if (!payload || typeof payload !== 'object') {
      return { status: 400, message: 'Invalid payload' };
    }

    const input = payload as Record<string, unknown>;
    const projectName = typeof input.projectName === 'string' ? input.projectName : undefined;
    const instanceId = typeof input.instanceId === 'string' ? input.instanceId : undefined;
    const permissionAllow = input.permissionAllow === true;
    if (!projectName) {
      return { status: 400, message: 'Missing projectName' };
    }

    const existingProject = this.deps.stateManager.getProject(projectName);
    if (!existingProject) {
      return { status: 404, message: 'Project not found' };
    }

    const project = normalizeProjectState(existingProject);
    const instance = instanceId
      ? getProjectInstance(project, instanceId)
      : listProjectInstances(project)[0];
    if (!instance) {
      return { status: 404, message: 'Instance not found' };
    }

    const adapter = agentRegistry.get(instance.agentType);
    if (!adapter) {
      return { status: 404, message: 'Agent adapter not found' };
    }

    const windowName = instance.tmuxWindow;
    const sessionName = project.tmuxSession;
    if (!windowName || !sessionName) {
      return { status: 400, message: 'Invalid project state' };
    }

    this.deps.runtime.setSessionEnv(sessionName, 'AGENT_DISCORD_PORT', String(this.deps.port));
    if (this.deps.runtime.windowExists(sessionName, windowName)) {
      return { status: 200, message: 'OK' };
    }

    const integration = installAgentIntegration(instance.agentType, project.projectPath, 'reinstall');
    const startCommand = withClaudePluginDir(
      adapter.getStartCommand(project.projectPath, permissionAllow),
      integration.claudePluginDir,
    );
    const envPrefix = buildExportPrefix(buildAgentLaunchEnv({
      projectName,
      port: this.deps.port,
      agentType: instance.agentType,
      instanceId: instance.instanceId,
      permissionAllow,
    }));

    this.deps.runtime.startAgentInWindow(sessionName, windowName, `${envPrefix}${startCommand}`);
    return { status: 200, message: 'OK' };
  }

  // ---------------------------------------------------------------------------
  // File handling
  // ---------------------------------------------------------------------------

  /**
   * Validate an array of file paths: each must exist and reside within the project directory.
   */
  private validateFilePaths(paths: string[], projectPath: string): string[] {
    if (!projectPath) return [];
    return paths.filter((p) => {
      if (!existsSync(p)) return false;
      try {
        const real = realpathSync(p);
        return real.startsWith(projectPath + '/') || real === projectPath;
      } catch {
        return false;
      }
    });
  }

  private async handleSendFiles(payload: unknown): Promise<StatusResult> {
    if (!payload || typeof payload !== 'object') {
      return { status: 400, message: 'Invalid payload' };
    }

    const event = payload as Record<string, unknown>;
    const projectName = typeof event.projectName === 'string' ? event.projectName : undefined;
    const agentType = typeof event.agentType === 'string' ? event.agentType : 'opencode';
    const instanceId = typeof event.instanceId === 'string' ? event.instanceId : undefined;
    const files = Array.isArray(event.files) ? (event.files as unknown[]).filter((f): f is string => typeof f === 'string') : [];

    if (!projectName) return { status: 400, message: 'Missing projectName' };
    if (files.length === 0) return { status: 400, message: 'No files provided' };

    const project = this.deps.stateManager.getProject(projectName);
    if (!project) return { status: 404, message: 'Project not found' };

    const normalizedProject = normalizeProjectState(project);
    const instance =
      (instanceId ? getProjectInstance(normalizedProject, instanceId) : undefined) ||
      getPrimaryInstanceForAgent(normalizedProject, agentType);
    const channelId = instance?.channelId;
    if (!channelId) return { status: 404, message: 'No channel found for project/agent' };

    const projectPath = project.projectPath ? resolve(project.projectPath) : '';
    const validFiles = this.validateFilePaths(files, projectPath);
    if (validFiles.length === 0) return { status: 400, message: 'No valid files' };

    console.log(
      `\uD83D\uDCE4 [${projectName}/${instance?.agentType || agentType}] send-files: ${validFiles.length} file(s)`,
    );

    await this.deps.messaging.sendToChannelWithFiles(channelId, '', validFiles);
    return { status: 200, message: 'OK' };
  }

  // ---------------------------------------------------------------------------
  // OpenCode event handling
  // ---------------------------------------------------------------------------

  private getEventText(payload: Record<string, unknown>): string | undefined {
    const direct = payload.text;
    if (typeof direct === 'string' && direct.trim().length > 0) return direct;

    const message = payload.message;
    if (typeof message === 'string' && message.trim().length > 0) return message;
    return undefined;
  }

  async handleOpencodeEvent(payload: unknown): Promise<boolean> {
    if (!payload || typeof payload !== 'object') return false;

    const event = payload as Record<string, unknown>;
    const projectName = typeof event.projectName === 'string' ? event.projectName : undefined;
    const agentType = typeof event.agentType === 'string' ? event.agentType : 'opencode';
    const instanceId = typeof event.instanceId === 'string' ? event.instanceId : undefined;
    const eventType = typeof event.type === 'string' ? event.type : undefined;

    if (!projectName) return false;

    const project = this.deps.stateManager.getProject(projectName);
    if (!project) return false;

    const normalizedProject = normalizeProjectState(project);
    const instance =
      (instanceId ? getProjectInstance(normalizedProject, instanceId) : undefined) ||
      getPrimaryInstanceForAgent(normalizedProject, agentType);
    const channelId = instance?.channelId;
    if (!channelId) return false;

    const text = this.getEventText(event);
    const resolvedAgentType = instance?.agentType || agentType;
    const resolvedInstanceId = instance?.instanceId;
    const instanceKey = resolvedInstanceId || resolvedAgentType;

    console.log(
      `\uD83D\uDD0D [${projectName}/${resolvedAgentType}${resolvedInstanceId ? `#${resolvedInstanceId}` : ''}] event=${eventType} text=${text ? `(${text.length} chars) ${text.substring(0, 100)}` : '(empty)'}`,
    );

    // Auto-create pending entry for tmux-initiated prompts (no Slack message triggered markPending)
    if (
      (eventType === 'tool.activity' || eventType === 'session.idle') &&
      !this.deps.pendingTracker.hasPending(projectName, resolvedAgentType, resolvedInstanceId)
    ) {
      await this.deps.pendingTracker.ensurePending(projectName, resolvedAgentType, channelId, resolvedInstanceId);
      // Streaming updater is started lazily on first activity (thinking/tool events)
    }

    // Capture the pending entry NOW (before the handler is queued) so that
    // a subsequent markPending for a newer request cannot overwrite it.
    const pendingSnapshot = this.deps.pendingTracker.getPending(projectName, resolvedAgentType, resolvedInstanceId);

    const ctx: EventContext = {
      event,
      projectName,
      channelId,
      agentType: resolvedAgentType,
      instanceId: resolvedInstanceId,
      instanceKey,
      text,
      projectPath: project.projectPath ? resolve(project.projectPath) : '',
      pendingSnapshot: pendingSnapshot ? { ...pendingSnapshot } : undefined,
    };

    const handler = eventType ? this.eventHandlers[eventType] : undefined;
    if (handler) return this.enqueueForChannel(channelId, () => handler(ctx));
    return true;
  }

  /**
   * Enqueue an event handler so that events targeting the same channel are
   * processed sequentially.  This prevents multiple prompt/notification
   * messages from being sent to Slack simultaneously.
   */
  private enqueueForChannel(channelId: string, fn: () => Promise<boolean>): Promise<boolean> {
    const previous = this.channelQueues.get(channelId) ?? Promise.resolve();
    let result = true;
    const next = previous
      .then(async () => { result = await fn(); })
      .catch(() => {})
      .finally(() => {
        // Clean up once the chain settles to avoid leaking memory
        if (this.channelQueues.get(channelId) === next) {
          this.channelQueues.delete(channelId);
        }
      });
    this.channelQueues.set(channelId, next);
    return next.then(() => result);
  }

  private clearThinkingTimer(key: string): void {
    const entry = this.thinkingTimers.get(key);
    if (entry) {
      clearInterval(entry.timer);
      this.thinkingTimers.delete(key);
    }
  }

  private clearSessionLifecycleTimer(key: string): void {
    const timer = this.sessionLifecycleTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.sessionLifecycleTimers.delete(key);
    }
  }

  // ---------------------------------------------------------------------------
  // Lazy start message creation
  // ---------------------------------------------------------------------------

  /**
   * Lazily create the "⏳ Processing..." start message and start the streaming
   * updater.  Called from thinking.start and tool.activity handlers so that
   * commands with no activity (e.g. /compact) never produce a parent message.
   */
  private async ensureStartMessageAndStreaming(ctx: EventContext): Promise<string | undefined> {
    const startMessageId = await this.deps.pendingTracker.ensureStartMessage(
      ctx.projectName, ctx.agentType, ctx.instanceId,
    );

    if (startMessageId) {
      // Update snapshot so subsequent code in this handler can use it
      if (ctx.pendingSnapshot) {
        ctx.pendingSnapshot.startMessageId = startMessageId;
      }

      // Start streaming updater if not already active
      if (!this.deps.streamingUpdater.has(ctx.projectName, ctx.instanceKey)) {
        const pending = this.deps.pendingTracker.getPending(ctx.projectName, ctx.agentType, ctx.instanceId);
        if (pending) {
          this.deps.streamingUpdater.start(ctx.projectName, ctx.instanceKey, pending.channelId, startMessageId);
        }
      }
    }

    return startMessageId;
  }

  // ---------------------------------------------------------------------------
  // Individual event handlers
  // ---------------------------------------------------------------------------

  private async handleSessionError(ctx: EventContext): Promise<boolean> {
    // Clear thinking timer if still running
    this.clearThinkingTimer(`${ctx.projectName}:${ctx.instanceKey}`);
    // Clear thread activity tracking
    this.threadActivityMessages.delete(`${ctx.projectName}:${ctx.instanceKey}`);
    // Discard any in-progress streaming message
    this.deps.streamingUpdater.discard(ctx.projectName, ctx.instanceKey);
    // Fire reaction update in background – don't block message delivery
    this.deps.pendingTracker.markError(ctx.projectName, ctx.agentType, ctx.instanceId).catch(() => {});
    const msg = ctx.text || 'unknown error';
    await this.deps.messaging.sendToChannel(ctx.channelId, `\u26A0\uFE0F OpenCode session error: ${msg}`);
    return true;
  }

  private async handleSessionNotification(ctx: EventContext): Promise<boolean> {
    const notificationType = typeof ctx.event.notificationType === 'string' ? ctx.event.notificationType : 'unknown';
    const emojiMap: Record<string, string> = {
      permission_prompt: '\uD83D\uDD10',
      idle_prompt: '\uD83D\uDCA4',
      auth_success: '\uD83D\uDD11',
      elicitation_dialog: '\u2753',
    };
    const emoji = emojiMap[notificationType] || '\uD83D\uDD14';
    const msg = ctx.text || notificationType;
    await this.deps.messaging.sendToChannel(ctx.channelId, `${emoji} ${msg}`);

    // Send prompt details (AskUserQuestion choices, ExitPlanMode) extracted from transcript
    const promptText = typeof ctx.event.promptText === 'string' ? ctx.event.promptText.trim() : '';
    if (promptText) {
      await this.splitAndSendToChannel(ctx.channelId, promptText);
    }

    return true;
  }

  private async handleSessionStart(ctx: EventContext): Promise<boolean> {
    const source = typeof ctx.event.source === 'string' ? ctx.event.source : 'unknown';
    const model = typeof ctx.event.model === 'string' ? ctx.event.model : '';
    const modelSuffix = model ? `, ${model}` : '';
    await this.deps.messaging.sendToChannel(ctx.channelId, `\u25B6\uFE0F Session started (${source}${modelSuffix})`);

    // Mark hook as active so buffer fallback defers to hook handling
    this.deps.pendingTracker.setHookActive(ctx.projectName, ctx.agentType, ctx.instanceId);

    // Start lifecycle timer — if no AI activity starts within the delay,
    // this was a local command (e.g. /model) and the pending entry should resolve.
    const timerKey = `${ctx.projectName}:${ctx.instanceKey}`;
    this.clearSessionLifecycleTimer(timerKey);
    const timer = setTimeout(() => {
      this.sessionLifecycleTimers.delete(timerKey);
      if (
        this.deps.pendingTracker.hasPending(ctx.projectName, ctx.agentType, ctx.instanceId) &&
        !this.deps.pendingTracker.getPending(ctx.projectName, ctx.agentType, ctx.instanceId)?.startMessageId
      ) {
        this.deps.pendingTracker.markCompleted(ctx.projectName, ctx.agentType, ctx.instanceId).catch(() => {});
      }
    }, BridgeHookServer.SESSION_LIFECYCLE_DELAY_MS);
    this.sessionLifecycleTimers.set(timerKey, timer);

    return true;
  }

  private async handleSessionEnd(ctx: EventContext): Promise<boolean> {
    const reason = typeof ctx.event.reason === 'string' ? ctx.event.reason : 'unknown';
    await this.deps.messaging.sendToChannel(ctx.channelId, `\u23F9\uFE0F Session ended (${reason})`);

    // Mark hook as active so buffer fallback defers to hook handling.
    // This is critical for /model: session.end fires immediately when the
    // command interrupts the current session — well before the 3s buffer fallback.
    this.deps.pendingTracker.setHookActive(ctx.projectName, ctx.agentType, ctx.instanceId);

    return true;
  }

  private async handleThinkingStart(ctx: EventContext): Promise<boolean> {
    // Cancel session lifecycle timer — AI activity started
    this.clearSessionLifecycleTimer(`${ctx.projectName}:${ctx.instanceKey}`);

    // Lazily create start message on first activity
    await this.ensureStartMessageAndStreaming(ctx);

    const pending = ctx.pendingSnapshot;
    if (pending?.messageId) {
      this.deps.messaging.addReactionToMessage(pending.channelId, pending.messageId, '\uD83E\uDDE0').catch(() => {});
    }

    // Show thinking indicator immediately, then update elapsed time periodically
    const timerKey = `${ctx.projectName}:${ctx.instanceKey}`;
    this.clearThinkingTimer(timerKey);
    const startTime = Date.now();
    this.deps.streamingUpdater.append(
      ctx.projectName, ctx.instanceKey,
      '\uD83E\uDDE0 Thinking\u2026',
    );
    const timer = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      this.deps.streamingUpdater.append(
        ctx.projectName, ctx.instanceKey,
        `\uD83E\uDDE0 Thinking\u2026 (${elapsed}s)`,
      );
    }, BridgeHookServer.THINKING_INTERVAL_MS);
    this.thinkingTimers.set(timerKey, { timer, startTime });

    return true;
  }

  private async handleThinkingStop(ctx: EventContext): Promise<boolean> {
    const pending = ctx.pendingSnapshot;

    // Show total thinking duration and clear the timer
    const timerKey = `${ctx.projectName}:${ctx.instanceKey}`;
    const entry = this.thinkingTimers.get(timerKey);
    if (entry) {
      const elapsed = Math.round((Date.now() - entry.startTime) / 1000);
      if (elapsed >= 5) {
        this.deps.streamingUpdater.append(
          ctx.projectName, ctx.instanceKey,
          `\uD83E\uDDE0 Thought for ${elapsed}s`,
        );
      }
    }
    this.clearThinkingTimer(timerKey);

    // Replace 🧠 reaction with ✅ to indicate thinking is complete
    if (pending?.messageId) {
      this.deps.messaging.replaceOwnReactionOnMessage(
        pending.channelId, pending.messageId, '\uD83E\uDDE0', '\u2705',
      ).catch(() => {});
    }
    return true;
  }

  private async handleToolActivity(ctx: EventContext): Promise<boolean> {
    // Cancel session lifecycle timer — AI activity started
    this.clearSessionLifecycleTimer(`${ctx.projectName}:${ctx.instanceKey}`);

    // Lazily create start message on first activity
    await this.ensureStartMessageAndStreaming(ctx);

    const pending = ctx.pendingSnapshot;

    // Update single thread message with accumulated tool activity (append mode)
    if (ctx.text && pending?.startMessageId) {
      const k = `${ctx.projectName}:${ctx.instanceKey}`;
      const existing = this.threadActivityMessages.get(k);

      if (existing && existing.parentMessageId === pending.startMessageId && this.deps.messaging.updateMessage) {
        // Append new activity line to thread message
        existing.lines.push(ctx.text);
        try {
          await this.deps.messaging.updateMessage(existing.channelId, existing.messageId, existing.lines.join('\n'));
        } catch (error) {
          console.warn('Failed to update thread activity message:', error);
        }
      } else if (this.deps.messaging.replyInThreadWithId) {
        // Create first thread message and track it
        try {
          const msgId = await this.deps.messaging.replyInThreadWithId(pending.channelId, pending.startMessageId, ctx.text);
          if (msgId) {
            this.threadActivityMessages.set(k, {
              channelId: pending.channelId,
              parentMessageId: pending.startMessageId,
              messageId: msgId,
              lines: [ctx.text],
            });
          }
        } catch (error) {
          console.warn('Failed to post tool activity as thread reply:', error);
        }
      } else if (this.deps.messaging.replyInThread) {
        // Fallback: no ID tracking available, post individual replies
        try {
          await this.deps.messaging.replyInThread(pending.channelId, pending.startMessageId, ctx.text);
        } catch (error) {
          console.warn('Failed to post tool activity as thread reply:', error);
        }
      }
    }

    // Update parent message with tool activity preview so the channel view shows progress
    if (ctx.text) {
      this.deps.streamingUpdater.append(ctx.projectName, ctx.instanceKey, ctx.text);
    }

    return true;
  }

  private async handleSessionIdle(ctx: EventContext): Promise<boolean> {
    // Clear thinking timer if still running
    this.clearThinkingTimer(`${ctx.projectName}:${ctx.instanceKey}`);
    // Cancel session lifecycle timer
    this.clearSessionLifecycleTimer(`${ctx.projectName}:${ctx.instanceKey}`);
    // Clear thread activity tracking
    this.threadActivityMessages.delete(`${ctx.projectName}:${ctx.instanceKey}`);

    // Get startMessageId from the live pending entry — it may have been created
    // lazily by thinking.start or tool.activity handlers after the snapshot was taken.
    const livePending = this.deps.pendingTracker.getPending(ctx.projectName, ctx.agentType, ctx.instanceId);
    const startMessageId = livePending?.startMessageId;

    // Finalize streaming message only if a start message was created (i.e. there was activity)
    const usage = ctx.event.usage as Record<string, unknown> | undefined;
    if (startMessageId) {
      const finalizeHeader = this.buildFinalizeHeader(usage);
      await this.deps.streamingUpdater.finalize(
        ctx.projectName, ctx.instanceKey,
        finalizeHeader || undefined,
        startMessageId,
      );
    }

    // Fire reaction update in background – don't block message delivery
    this.deps.pendingTracker.markCompleted(ctx.projectName, ctx.agentType, ctx.instanceId).catch(() => {});

    // Thread replies — only possible if a start message exists
    const pending: PendingEntry | undefined = startMessageId
      ? { channelId: ctx.channelId, messageId: ctx.pendingSnapshot?.messageId || '', startMessageId }
      : undefined;
    await this.postUsageAsThreadReply(pending, usage);
    await this.postIntermediateTextAsThreadReply(pending, ctx.event);
    await this.postThinkingAsThreadReply(pending, ctx.event);

    // Main response text + files
    await this.postResponseText(ctx);

    // Prompt choices (AskUserQuestion, ExitPlanMode)
    await this.postPromptChoices(ctx);

    return true;
  }

  // ---------------------------------------------------------------------------
  // session.idle sub-methods
  // ---------------------------------------------------------------------------

  private buildFinalizeHeader(usage: Record<string, unknown> | undefined): string | undefined {
    if (!usage || typeof usage !== 'object') return undefined;
    const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
    const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
    const totalTokens = inputTokens + outputTokens;
    const totalCost = typeof usage.totalCostUsd === 'number' ? usage.totalCostUsd : 0;
    const parts: string[] = ['\u2705 Done'];
    if (totalTokens > 0) parts.push(`${totalTokens.toLocaleString()} tokens`);
    if (totalCost > 0) parts.push(`$${totalCost.toFixed(2)}`);
    return parts.join(' \u00B7 ');
  }

  private async postUsageAsThreadReply(
    pending: PendingEntry | undefined,
    usage: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (!usage || typeof usage !== 'object' || !pending?.startMessageId || !this.deps.messaging.replyInThread) return;
    const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
    const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
    const totalCost = typeof usage.totalCostUsd === 'number' ? usage.totalCostUsd : 0;
    if (inputTokens > 0 || outputTokens > 0) {
      const usageLine = `\uD83D\uDCCA Input: ${inputTokens.toLocaleString()} \u00B7 Output: ${outputTokens.toLocaleString()}${totalCost > 0 ? ` \u00B7 Cost: $${totalCost.toFixed(2)}` : ''}`;
      try {
        await this.deps.messaging.replyInThread(pending.channelId, pending.startMessageId, usageLine);
      } catch { /* ignore usage reply failures */ }
    }
  }

  private async postIntermediateTextAsThreadReply(
    pending: PendingEntry | undefined,
    event: Record<string, unknown>,
  ): Promise<void> {
    const intermediateText = typeof event.intermediateText === 'string' ? event.intermediateText.trim() : '';
    if (!intermediateText || !pending?.startMessageId || !this.deps.messaging.replyInThread) return;
    try {
      await this.splitAndSendAsThreadReply(pending.channelId, pending.startMessageId, intermediateText);
    } catch (error) {
      console.warn('Failed to post intermediate text as thread reply:', error);
    }
  }

  private async postThinkingAsThreadReply(
    pending: PendingEntry | undefined,
    event: Record<string, unknown>,
  ): Promise<void> {
    const thinking = typeof event.thinking === 'string' ? event.thinking.trim() : '';
    if (!thinking || !pending?.startMessageId || !this.deps.messaging.replyInThread) return;
    try {
      const maxLen = 12000;
      let thinkingText = thinking.length > maxLen
        ? thinking.substring(0, maxLen) + '\n\n_(truncated)_'
        : thinking;
      thinkingText = `:brain: *Reasoning*\n\`\`\`\n${thinkingText}\n\`\`\``;
      await this.splitAndSendAsThreadReply(pending.channelId, pending.startMessageId, thinkingText);
    } catch (error) {
      console.warn('Failed to post thinking as thread reply:', error);
    }
  }

  private async postResponseText(ctx: EventContext): Promise<void> {
    if (!ctx.text || ctx.text.trim().length === 0) return;

    const trimmed = ctx.text.trim();
    // Use turnText (all assistant text from the turn) for file path extraction
    // to handle the race condition where displayText doesn't contain file paths
    const turnText = typeof ctx.event.turnText === 'string' ? ctx.event.turnText.trim() : '';
    const fileSearchText = turnText || trimmed;
    const filePaths = this.validateFilePaths(extractFilePaths(fileSearchText), ctx.projectPath);

    // Strip file paths from the display text to avoid leaking absolute paths
    const displayText = filePaths.length > 0 ? stripFilePaths(trimmed, filePaths) : trimmed;

    await this.splitAndSendToChannel(ctx.channelId, displayText);

    if (filePaths.length > 0) {
      await this.deps.messaging.sendToChannelWithFiles(ctx.channelId, '', filePaths);
    }
  }

  private async postPromptChoices(ctx: EventContext): Promise<void> {
    // Send prompt choices (AskUserQuestion, ExitPlanMode) as channel message
    const promptText = typeof ctx.event.promptText === 'string' ? ctx.event.promptText.trim() : '';
    if (!promptText) return;
    await this.splitAndSendToChannel(ctx.channelId, promptText);
  }

  // ---------------------------------------------------------------------------
  // Shared message splitting helpers
  // ---------------------------------------------------------------------------

  private async splitAndSendToChannel(channelId: string, text: string): Promise<void> {
    const split = this.deps.messaging.platform === 'slack' ? splitForSlack : splitForDiscord;
    const chunks = split(text);
    for (const chunk of chunks) {
      if (chunk.trim().length > 0) {
        await this.deps.messaging.sendToChannel(channelId, chunk);
      }
    }
  }

  private async splitAndSendAsThreadReply(channelId: string, messageId: string, text: string): Promise<void> {
    if (!this.deps.messaging.replyInThread) return;
    const split = this.deps.messaging.platform === 'slack' ? splitForSlack : splitForDiscord;
    const chunks = split(text);
    for (const chunk of chunks) {
      if (chunk.trim().length > 0) {
        await this.deps.messaging.replyInThread(channelId, messageId, chunk);
      }
    }
  }
}
