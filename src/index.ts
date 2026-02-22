/**
 * Main entry point for discode
 */

import { DiscordClient } from './discord/client.js';
import { SlackClient } from './slack/client.js';
import type { MessagingClient } from './messaging/interface.js';
import type { AgentRuntime } from './runtime/interface.js';
import { TmuxRuntime } from './runtime/tmux-runtime.js';
import { PtyRuntime } from './runtime/pty-runtime.js';
import { stateManager as defaultStateManager } from './state/index.js';
import { config as defaultConfig } from './config/index.js';
import { agentRegistry as defaultAgentRegistry, AgentRegistry } from './agents/index.js';
import type { ProjectAgents } from './types/index.js';
import type { IStateManager } from './types/interfaces.js';
import type { BridgeConfig } from './types/index.js';
import {
  buildNextInstanceId,
  getProjectInstance,
  listProjectInstances,
  normalizeProjectState,
} from './state/instances.js';
import { installFileInstruction } from './infra/file-instruction.js';
import { installDiscodeSendScript } from './infra/send-script.js';
import { buildAgentLaunchEnv, buildContainerEnv, buildExportPrefix, withClaudePluginDir } from './policy/agent-launch.js';
import { installAgentIntegration } from './policy/agent-integration.js';
import { getPluginSourcePath as getOpencodePluginSourcePath } from './opencode/plugin-installer.js';
import { getGeminiHookSourcePath, GEMINI_AFTER_AGENT_HOOK_FILENAME, GEMINI_NOTIFICATION_HOOK_FILENAME, GEMINI_SESSION_HOOK_FILENAME } from './gemini/hook-installer.js';
import { resolveProjectWindowName, toProjectScopedName } from './policy/window-naming.js';
import {
  isDockerAvailable,
  createContainer,
  buildDockerStartCommand,
  injectCredentials,
  injectChromeMcpBridge,
  injectFile,
  ChromeMcpProxy,
  WORKSPACE_DIR,
} from './container/index.js';
import { ContainerSync } from './container/sync.js';
import { PendingMessageTracker } from './bridge/pending-message-tracker.js';
import { BridgeProjectBootstrap } from './bridge/project-bootstrap.js';
import { BridgeMessageRouter } from './bridge/message-router.js';
import { BridgeHookServer } from './bridge/hook-server.js';
import { StreamingMessageUpdater } from './bridge/streaming-message-updater.js';
import { RuntimeStreamServer, getDefaultRuntimeSocketPath } from './runtime/stream-server.js';
import { ClaudeSdkRunner } from './sdk/index.js';

export interface AgentBridgeDeps {
  messaging?: MessagingClient;
  /** @deprecated Use `runtime` instead. */
  tmux?: AgentRuntime;
  runtime?: AgentRuntime;
  stateManager?: IStateManager;
  registry?: AgentRegistry;
  config?: BridgeConfig;
}

export class AgentBridge {
  private messaging: MessagingClient;
  private runtime: AgentRuntime;
  private pendingTracker: PendingMessageTracker;
  private projectBootstrap: BridgeProjectBootstrap;
  private messageRouter: BridgeMessageRouter;
  private hookServer: BridgeHookServer;
  private streamServer: RuntimeStreamServer;
  private stateManager: IStateManager;
  private registry: AgentRegistry;
  private bridgeConfig: BridgeConfig;
  /** Active container sync instances keyed by `projectName#instanceId`. */
  private containerSyncs = new Map<string, ContainerSync>();
  /** TCP proxy bridging Chrome extension socket to containers. */
  private chromeMcpProxy: ChromeMcpProxy | null = null;
  /** SDK runner instances keyed by `projectName:instanceId`. */
  private sdkRunners = new Map<string, ClaudeSdkRunner>();

  constructor(deps?: AgentBridgeDeps) {
    this.bridgeConfig = deps?.config || defaultConfig;
    this.messaging = deps?.messaging || this.createMessagingClient();
    this.runtime = deps?.runtime || deps?.tmux || this.createRuntime();
    this.stateManager = deps?.stateManager || defaultStateManager;
    this.registry = deps?.registry || defaultAgentRegistry;
    this.pendingTracker = new PendingMessageTracker(this.messaging);
    const streamingUpdater = new StreamingMessageUpdater(this.messaging);
    this.projectBootstrap = new BridgeProjectBootstrap(this.stateManager, this.messaging, this.bridgeConfig.hookServerPort || 18470);
    this.messageRouter = new BridgeMessageRouter({
      messaging: this.messaging,
      runtime: this.runtime,
      stateManager: this.stateManager,
      pendingTracker: this.pendingTracker,
      streamingUpdater,
      sanitizeInput: (content) => this.sanitizeInput(content),
      getSdkRunner: (projectName, instanceId) => this.sdkRunners.get(`${projectName}:${instanceId}`),
    });
    this.hookServer = new BridgeHookServer({
      port: this.bridgeConfig.hookServerPort || 18470,
      messaging: this.messaging,
      stateManager: this.stateManager,
      pendingTracker: this.pendingTracker,
      streamingUpdater,
      runtime: this.runtime,
      reloadChannelMappings: () => this.projectBootstrap.reloadChannelMappings(),
    });
    this.streamServer = new RuntimeStreamServer(this.runtime, getDefaultRuntimeSocketPath());
  }

  private createRuntime(): AgentRuntime {
    if (this.bridgeConfig.runtimeMode === 'pty') {
      return new PtyRuntime();
    }
    return TmuxRuntime.create(this.bridgeConfig.tmux.sessionPrefix);
  }

  private createMessagingClient(): MessagingClient {
    if (this.bridgeConfig.messagingPlatform === 'slack') {
      if (!this.bridgeConfig.slack) {
        throw new Error('Slack is configured as messaging platform but Slack tokens are missing. Run: discode onboard --platform slack');
      }
      return new SlackClient(this.bridgeConfig.slack.botToken, this.bridgeConfig.slack.appToken);
    }
    return new DiscordClient(this.bridgeConfig.discord.token);
  }

  /**
   * Sanitize message input before passing to runtime
   */
  public sanitizeInput(content: string): string | null {
    // Reject empty/whitespace-only messages
    if (!content || content.trim().length === 0) {
      return null;
    }

    // Limit message length to prevent abuse
    if (content.length > 10000) {
      return null;
    }

    // Strip null bytes
    const sanitized = content.replace(/\0/g, '');

    return sanitized;
  }

  /**
   * Connect messaging client (for init command)
   */
  async connect(): Promise<void> {
    await this.messaging.connect();
  }

  async start(): Promise<void> {
    console.log('🚀 Starting Discode...');

    await this.messaging.connect();
    console.log('✅ Messaging client connected');

    // Start Chrome MCP proxy if a Chrome extension socket exists.
    // This bridges the host's Chrome extension Unix socket to TCP
    // so containers can reach it via host.docker.internal.
    try {
      const proxy = new ChromeMcpProxy({ port: (this.bridgeConfig.hookServerPort || 18470) + 1 });
      if (await proxy.start()) {
        this.chromeMcpProxy = proxy;
        console.log(`🌐 Chrome MCP proxy listening on port ${proxy.getPort()}`);
      }
    } catch {
      // Non-critical: proxy failure should not prevent daemon startup.
    }

    const projects = this.projectBootstrap.bootstrapProjects();
    this.injectContainerPlugins(projects);
    this.restoreRuntimeWindowsIfNeeded();
    this.messageRouter.register();
    this.hookServer.start();
    this.streamServer.start();

    console.log('✅ Discode is running');
    console.log(`📡 Server listening on port ${this.bridgeConfig.hookServerPort || 18470}`);
    console.log(`🤖 Registered agents: ${this.registry.getAll().map(a => a.config.displayName).join(', ')}`);
  }

  /**
   * Inject agent plugins/hooks into existing container instances on daemon restart.
   * This ensures containers created before the injection code was added still
   * get their event hook, and covers cases where the daemon restarts.
   */
  private injectContainerPlugins(projects: ReturnType<IStateManager['listProjects']>): void {
    const socketPath = this.bridgeConfig.container?.socketPath || undefined;
    for (const rawProject of projects) {
      const project = normalizeProjectState(rawProject);
      for (const instance of listProjectInstances(project)) {
        if (!instance.containerMode || !instance.containerId) continue;

        if (instance.agentType === 'opencode') {
          const pluginSource = getOpencodePluginSourcePath();
          if (injectFile(instance.containerId, pluginSource, '/home/coder/.opencode/plugins', socketPath)) {
            console.log(`🧩 Injected OpenCode plugin into container ${instance.containerId.slice(0, 12)}`);
          }
        } else if (instance.agentType === 'gemini') {
          const geminiHooksDir = '/home/coder/.gemini/discode-hooks';
          for (const hookFile of [GEMINI_AFTER_AGENT_HOOK_FILENAME, GEMINI_NOTIFICATION_HOOK_FILENAME, GEMINI_SESSION_HOOK_FILENAME]) {
            injectFile(instance.containerId, getGeminiHookSourcePath(hookFile), geminiHooksDir, socketPath);
          }
          console.log(`🪝 Injected Gemini hooks into container ${instance.containerId.slice(0, 12)}`);
        }
      }
    }
  }

  async setupProject(
    projectName: string,
    projectPath: string,
    agents: ProjectAgents,
    channelDisplayName?: string,
    overridePort?: number,
    options?: { instanceId?: string; skipRuntimeStart?: boolean },
  ): Promise<{ channelName: string; channelId: string; agentName: string; tmuxSession: string }> {
    const isSlack = this.bridgeConfig.messagingPlatform === 'slack';
    const guildId = isSlack ? this.stateManager.getWorkspaceId() : this.stateManager.getGuildId();
    if (!guildId) {
      throw new Error('Server ID not configured. Run: discode config --server <id>');
    }

    // Collect enabled agents (should be only one)
    const enabledAgents = this.registry.getAll().filter(a => agents[a.config.name]);
    const adapter = enabledAgents[0];

    if (!adapter) {
      throw new Error('No agent specified');
    }

    const existingProject = this.stateManager.getProject(projectName);
    const normalizedExisting = existingProject ? normalizeProjectState(existingProject) : undefined;

    const requestedInstanceId = options?.instanceId?.trim();
    const instanceId = requestedInstanceId || buildNextInstanceId(normalizedExisting, adapter.config.name);
    if (normalizedExisting && getProjectInstance(normalizedExisting, instanceId)) {
      throw new Error(`Instance already exists: ${instanceId}`);
    }

    // Create tmux session (shared mode)
    const sharedSessionName = this.bridgeConfig.tmux.sharedSessionName || 'bridge';
    const windowName = toProjectScopedName(projectName, adapter.config.name, instanceId);
    const tmuxSession = this.runtime.getOrCreateSession(sharedSessionName, windowName);

    // Create Discord channel with custom name or default
    const channelName = channelDisplayName || toProjectScopedName(projectName, adapter.config.channelSuffix, instanceId);
    const channels = await this.messaging.createAgentChannels(
      guildId,
      projectName,
      [adapter.config],
      channelName,
      { [adapter.config.name]: instanceId },
    );

    const channelId = channels[adapter.config.name];

    const port = overridePort || this.bridgeConfig.hookServerPort || 18470;
    // Avoid setting AGENT_DISCORD_PROJECT on shared session env (ambiguous across windows).
    this.runtime.setSessionEnv(tmuxSession, 'AGENT_DISCORD_PORT', String(port));

    // Start agent in tmux window
    const permissionAllow = this.bridgeConfig.opencode?.permissionMode === 'allow';
    const integration = installAgentIntegration(adapter.config.name, projectPath, 'install');
    for (const message of integration.infoMessages) {
      console.log(message);
    }
    for (const message of integration.warningMessages) {
      console.warn(message);
    }

    // Install file-handling instructions and discode-send script for the agent
    try {
      installFileInstruction(projectPath, adapter.config.name);
      console.log(`📎 Installed file instructions for ${adapter.config.displayName}`);
    } catch (error) {
      console.warn(`Failed to install file instructions: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      installDiscodeSendScript(projectPath, { projectName, port });
    } catch {
      // Non-critical.
    }

    const setupParams = {
      agentName: adapter.config.name,
      projectName,
      projectPath,
      instanceId,
      tmuxSession,
      windowName,
      port,
      permissionAllow,
      claudePluginDir: integration.claudePluginDir,
      getStartCommand: (path: string, permAllow: boolean) => adapter.getStartCommand(path, permAllow),
      skipRuntimeStart: options?.skipRuntimeStart,
    };

    const containerMode = !!this.bridgeConfig.container?.enabled;
    let containerId: string | undefined;
    let containerName: string | undefined;

    if (containerMode) {
      const result = this.setupContainerInstance(setupParams);
      containerId = result.containerId;
      containerName = result.containerName;
    } else {
      this.setupStandardInstance(setupParams);
    }

    this.saveProjectState({
      normalizedExisting,
      projectName,
      projectPath,
      tmuxSession,
      instanceId,
      agentName: adapter.config.name,
      windowName,
      channelId,
      eventHookInstalled: integration.eventHookInstalled,
      containerMode,
      containerId,
      containerName,
    });

    return {
      channelName,
      channelId,
      agentName: adapter.config.displayName,
      tmuxSession,
    };
  }

  private setupContainerInstance(p: {
    agentName: string;
    projectName: string;
    projectPath: string;
    instanceId: string;
    tmuxSession: string;
    windowName: string;
    port: number;
    permissionAllow: boolean;
    claudePluginDir: string | undefined;
    getStartCommand: (path: string, permAllow: boolean) => string;
    skipRuntimeStart?: boolean;
  }): { containerId: string; containerName: string } {
    const socketPath = this.bridgeConfig.container?.socketPath || undefined;
    if (!isDockerAvailable(socketPath)) {
      throw new Error('Container mode is enabled but Docker is not available. Is Docker running?');
    }

    const containerName = `discode-${p.projectName}-${p.instanceId}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const containerEnv = buildContainerEnv({
      projectName: p.projectName,
      port: p.port,
      agentType: p.agentName,
      instanceId: p.instanceId,
      permissionAllow: p.agentName === 'opencode' && p.permissionAllow,
    });

    // Build agent command for execution inside the container
    const containerAgentCmd = p.getStartCommand(WORKSPACE_DIR, p.permissionAllow);
    const containerPluginDir = '/home/coder/.claude/plugins/discode-claude-bridge';
    const agentCommand = withClaudePluginDir(containerAgentCmd, p.claudePluginDir ? containerPluginDir : undefined);

    // Mount host plugin dir into container (read-only) if available
    const volumes: string[] = [];
    if (p.claudePluginDir) {
      volumes.push(`${p.claudePluginDir}:${containerPluginDir}:ro`);
    }

    const containerId = createContainer({
      containerName,
      projectPath: p.projectPath,
      agentType: p.agentName,
      socketPath,
      env: containerEnv,
      command: agentCommand,
      volumes,
    });

    // Inject Claude credentials into the container
    injectCredentials(containerId, socketPath);

    // Always inject Chrome MCP bridge config so the container can reach
    // the proxy that the daemon runs on hookServerPort + 1.
    const chromeMcpPort = (this.bridgeConfig.hookServerPort || 18470) + 1;
    if (injectChromeMcpBridge(containerId, chromeMcpPort, p.agentName, socketPath)) {
      console.log('🌐 Injected Chrome MCP bridge into container');
    }

    // Inject agent event hook/plugin into the container so responses
    // come through the structured event hook, not the screen capture fallback.
    if (p.agentName === 'opencode') {
      const pluginSource = getOpencodePluginSourcePath();
      if (injectFile(containerId, pluginSource, '/home/coder/.opencode/plugins', socketPath)) {
        console.log('🧩 Injected OpenCode plugin into container');
      }
    } else if (p.agentName === 'gemini') {
      const geminiHooksDir = '/home/coder/.gemini/discode-hooks';
      for (const hookFile of [GEMINI_AFTER_AGENT_HOOK_FILENAME, GEMINI_NOTIFICATION_HOOK_FILENAME, GEMINI_SESSION_HOOK_FILENAME]) {
        injectFile(containerId, getGeminiHookSourcePath(hookFile), geminiHooksDir, socketPath);
      }
      console.log('🪝 Injected Gemini hooks into container');
    }

    // The runtime command becomes `docker start -ai <containerId>`
    const dockerStartCmd = buildDockerStartCommand(containerId, socketPath);
    if (!p.skipRuntimeStart) {
      this.runtime.startAgentInWindow(p.tmuxSession, p.windowName, dockerStartCmd);
    }

    // Start periodic file sync
    const sync = new ContainerSync({
      containerId,
      projectPath: p.projectPath,
      socketPath,
      intervalMs: this.bridgeConfig.container?.syncIntervalMs,
    });
    sync.start();
    this.containerSyncs.set(`${p.projectName}#${p.instanceId}`, sync);

    return { containerId, containerName };
  }

  private setupStandardInstance(p: {
    agentName: string;
    projectName: string;
    projectPath: string;
    instanceId: string;
    tmuxSession: string;
    windowName: string;
    port: number;
    permissionAllow: boolean;
    claudePluginDir: string | undefined;
    getStartCommand: (path: string, permAllow: boolean) => string;
    skipRuntimeStart?: boolean;
  }): void {
    const exportPrefix = buildExportPrefix(buildAgentLaunchEnv({
      projectName: p.projectName,
      port: p.port,
      agentType: p.agentName,
      instanceId: p.instanceId,
      permissionAllow: p.agentName === 'opencode' && p.permissionAllow,
    }));
    const startCommand = withClaudePluginDir(p.getStartCommand(p.projectPath, p.permissionAllow), p.claudePluginDir);

    if (!p.skipRuntimeStart) {
      this.runtime.startAgentInWindow(p.tmuxSession, p.windowName, `${exportPrefix}${startCommand}`);
    }
  }

  private saveProjectState(p: {
    normalizedExisting: ReturnType<typeof normalizeProjectState> | undefined;
    projectName: string;
    projectPath: string;
    tmuxSession: string;
    instanceId: string;
    agentName: string;
    windowName: string;
    channelId: string;
    eventHookInstalled: boolean;
    containerMode: boolean;
    containerId?: string;
    containerName?: string;
  }): void {
    const baseProject = p.normalizedExisting || {
      projectName: p.projectName,
      projectPath: p.projectPath,
      tmuxSession: p.tmuxSession,
      createdAt: new Date(),
      lastActive: new Date(),
      agents: {},
      discordChannels: {},
      instances: {},
    };
    const nextInstances = {
      ...(baseProject.instances || {}),
      [p.instanceId]: {
        instanceId: p.instanceId,
        agentType: p.agentName,
        tmuxWindow: p.windowName,
        channelId: p.channelId,
        eventHook: p.agentName === 'opencode' || p.eventHookInstalled,
        ...(p.containerMode ? { containerMode: true, containerId: p.containerId, containerName: p.containerName } : {}),
      },
    };
    const projectState = normalizeProjectState({
      ...baseProject,
      projectName: p.projectName,
      projectPath: p.projectPath,
      tmuxSession: p.tmuxSession,
      instances: nextInstances,
      lastActive: new Date(),
    });
    this.stateManager.setProject(projectState);
  }

  /**
   * Create an SDK runner for an instance and register it in the map.
   * The runner's onEvent callback routes events through the hook server.
   */
  createSdkRunner(
    projectName: string,
    instanceId: string,
    agentType: string,
    projectPath: string,
    options?: { model?: string; permissionAllow?: boolean },
  ): ClaudeSdkRunner {
    const key = `${projectName}:${instanceId}`;
    const existing = this.sdkRunners.get(key);
    if (existing) return existing;

    const runner = new ClaudeSdkRunner({
      projectName,
      instanceId,
      agentType,
      projectPath,
      model: options?.model,
      permissionAllow: options?.permissionAllow ?? false,
      onEvent: (payload) => this.hookServer.handleOpencodeEvent(payload),
    });

    this.sdkRunners.set(key, runner);
    return runner;
  }

  async stop(): Promise<void> {
    // Stop Chrome MCP proxy
    if (this.chromeMcpProxy) {
      this.chromeMcpProxy.stop();
      this.chromeMcpProxy = null;
    }

    // Dispose all SDK runners
    for (const [, runner] of this.sdkRunners) {
      runner.dispose();
    }
    this.sdkRunners.clear();

    // Stop all container syncs
    for (const [, sync] of this.containerSyncs) {
      sync.stop();
    }
    this.containerSyncs.clear();

    this.streamServer.stop();
    this.hookServer.stop();
    this.runtime.dispose?.('SIGTERM');
    await this.messaging.disconnect();
  }

  private restoreRuntimeWindowsIfNeeded(): void {
    if ((this.bridgeConfig.runtimeMode || 'tmux') !== 'pty') return;

    const port = this.bridgeConfig.hookServerPort || 18470;
    const permissionAllow = this.bridgeConfig.opencode?.permissionMode === 'allow';
    const socketPath = this.bridgeConfig.container?.socketPath || undefined;

    for (const raw of this.stateManager.listProjects()) {
      const project = normalizeProjectState(raw);
      this.runtime.setSessionEnv(project.tmuxSession, 'AGENT_DISCORD_PORT', String(port));

      for (const instance of listProjectInstances(project)) {
        const adapter = this.registry.get(instance.agentType);
        if (!adapter) continue;

        if (instance.runtimeType === 'sdk') {
          this.restoreSdkInstance(project, instance, permissionAllow);
          continue;
        }

        const windowName = resolveProjectWindowName(
          project,
          instance.agentType,
          this.bridgeConfig.tmux,
          instance.instanceId,
        );

        if (this.runtime.windowExists(project.tmuxSession, windowName)) continue;

        if (instance.containerMode && instance.containerId) {
          this.restoreContainerInstance(project, { ...instance, containerId: instance.containerId }, windowName, socketPath);
          continue;
        }

        this.restoreStandardInstance(project, instance, windowName, port, permissionAllow, adapter);
      }
    }
  }

  private restoreSdkInstance(
    project: ReturnType<typeof normalizeProjectState>,
    instance: { instanceId: string; agentType: string },
    permissionAllow: boolean,
  ): void {
    this.createSdkRunner(
      project.projectName,
      instance.instanceId,
      instance.agentType,
      project.projectPath,
      { permissionAllow },
    );
    console.log(`🔄 Restored SDK runner for ${project.projectName}#${instance.instanceId}`);
  }

  private restoreContainerInstance(
    project: ReturnType<typeof normalizeProjectState>,
    instance: { instanceId: string; containerId: string },
    windowName: string,
    socketPath: string | undefined,
  ): void {
    const dockerStartCmd = buildDockerStartCommand(instance.containerId, socketPath);
    this.runtime.startAgentInWindow(project.tmuxSession, windowName, dockerStartCmd);

    // Restart file sync
    const sync = new ContainerSync({
      containerId: instance.containerId,
      projectPath: project.projectPath,
      socketPath,
      intervalMs: this.bridgeConfig.container?.syncIntervalMs,
    });
    sync.start();
    this.containerSyncs.set(`${project.projectName}#${instance.instanceId}`, sync);
  }

  private restoreStandardInstance(
    project: ReturnType<typeof normalizeProjectState>,
    instance: { instanceId: string; agentType: string },
    windowName: string,
    port: number,
    permissionAllow: boolean,
    adapter: { getStartCommand(path: string, permAllow: boolean): string },
  ): void {
    const integration = installAgentIntegration(instance.agentType, project.projectPath, 'reinstall');
    const startCommand = withClaudePluginDir(
      adapter.getStartCommand(project.projectPath, permissionAllow),
      integration.claudePluginDir,
    );
    const exportPrefix = buildExportPrefix(buildAgentLaunchEnv({
      projectName: project.projectName,
      port,
      agentType: instance.agentType,
      instanceId: instance.instanceId,
      permissionAllow: instance.agentType === 'opencode' && permissionAllow,
    }));

    this.runtime.startAgentInWindow(project.tmuxSession, windowName, `${exportPrefix}${startCommand}`);
  }
}

export async function main() {
  const bridge = new AgentBridge();

  process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down...');
    try {
      await bridge.stop();
    } catch (error) {
      console.error('Error during shutdown:', error);
    }
    process.exit(0);
  });

  await bridge.start();
}

function isDirectExecution(): boolean {
  // Bun compile/runtime provides import.meta.main; rely on it when available.
  const bunMain = (import.meta as ImportMeta & { main?: boolean }).main;
  if (typeof bunMain === 'boolean') {
    return bunMain;
  }

  const argv1 = process.argv[1];
  if (!argv1) return false;
  return import.meta.url === `file://${argv1}`;
}

// Run if called directly
if (isDirectExecution()) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
