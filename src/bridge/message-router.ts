import { execSync } from 'child_process';
import type { MessagingClient } from '../messaging/interface.js';
import type { IStateManager } from '../types/interfaces.js';
import type { AgentRuntime } from '../runtime/interface.js';
import {
  findProjectInstanceByChannel,
  getPrimaryInstanceForAgent,
  getProjectInstance,
  normalizeProjectState,
} from '../state/instances.js';
import { PendingMessageTracker } from './pending-message-tracker.js';
import type { StreamingMessageUpdater } from './streaming-message-updater.js';
import type { ClaudeSdkRunner } from '../sdk/index.js';
import { processAttachments } from './message-file-handler.js';
import { scheduleBufferFallback } from './message-buffer-fallback.js';

export interface BridgeMessageRouterDeps {
  messaging: MessagingClient;
  runtime: AgentRuntime;
  stateManager: IStateManager;
  pendingTracker: PendingMessageTracker;
  streamingUpdater: StreamingMessageUpdater;
  sanitizeInput: (content: string) => string | null;
  getSdkRunner?: (projectName: string, instanceId: string) => ClaudeSdkRunner | undefined;
}

export class BridgeMessageRouter {
  private fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private deps: BridgeMessageRouterDeps) {}

  register(): void {
    const { messaging } = this.deps;

    messaging.onMessage(async (agentType, content, projectName, channelId, messageId, mappedInstanceId, attachments) => {
      console.log(
        `📨 [${projectName}/${agentType}${mappedInstanceId ? `#${mappedInstanceId}` : ''}] ${content.substring(0, 50)}...`,
      );

      const project = this.deps.stateManager.getProject(projectName);
      if (!project) {
        console.warn(`Project ${projectName} not found in state`);
        await messaging.sendToChannel(channelId, `⚠️ Project "${projectName}" not found in state`);
        return;
      }

      const normalizedProject = normalizeProjectState(project);
      const mappedInstance =
        (mappedInstanceId ? getProjectInstance(normalizedProject, mappedInstanceId) : undefined) ||
        findProjectInstanceByChannel(normalizedProject, channelId) ||
        getPrimaryInstanceForAgent(normalizedProject, agentType);
      if (!mappedInstance) {
        await messaging.sendToChannel(channelId, '⚠️ Agent instance mapping not found for this channel');
        return;
      }

      const resolvedAgentType = mappedInstance.agentType;
      const instanceKey = mappedInstance.instanceId;
      const windowName = mappedInstance.tmuxWindow || instanceKey;

      // Process file attachments (isolated in message-file-handler.ts)
      let enrichedContent = content;
      if (attachments && attachments.length > 0) {
        const markers = await processAttachments(
          attachments,
          project.projectPath,
          mappedInstance,
          `${projectName}/${agentType}`,
        );
        if (markers) {
          enrichedContent = content + markers;
        }
      }

      const sanitized = this.deps.sanitizeInput(enrichedContent);
      if (!sanitized) {
        await messaging.sendToChannel(channelId, '⚠️ Invalid message: empty, too long (>10000 chars), or contains invalid characters');
        return;
      }

      // Shell command: messages starting with ! are executed directly on the host
      if (sanitized.startsWith('!')) {
        const command = sanitized.substring(1).trim();
        if (command.length > 0) {
          await this.executeShellCommand(command, project.projectPath, channelId);
        }
        this.deps.stateManager.updateLastActive(projectName);
        return;
      }

      if (messageId) {
        await this.deps.pendingTracker.markPending(projectName, resolvedAgentType, channelId, messageId, instanceKey);
      }

      if (mappedInstance.runtimeType === 'sdk') {
        const runner = this.deps.getSdkRunner?.(projectName, instanceKey);
        if (!runner) {
          await this.deps.pendingTracker.markError(projectName, resolvedAgentType, instanceKey);
          await messaging.sendToChannel(channelId, '\u26A0\uFE0F SDK runner not found for this instance. Try restarting the project.');
          this.deps.stateManager.updateLastActive(projectName);
          return;
        }
        runner.submitMessage(sanitized).catch((err) => {
          console.error(`[sdk-runner] submitMessage error for ${instanceKey}:`, err);
        });
      } else {
        try {
          await this.submitToAgent(normalizedProject.tmuxSession, windowName, sanitized, resolvedAgentType);
          scheduleBufferFallback(
            { messaging: this.deps.messaging, runtime: this.deps.runtime, pendingTracker: this.deps.pendingTracker },
            this.fallbackTimers,
            normalizedProject.tmuxSession,
            windowName,
            projectName,
            resolvedAgentType,
            instanceKey,
            channelId,
          );
        } catch (error) {
          await this.deps.pendingTracker.markError(projectName, resolvedAgentType, instanceKey);
          await messaging.sendToChannel(channelId, this.buildDeliveryFailureGuidance(projectName, error));
        }
      }

      this.deps.stateManager.updateLastActive(projectName);
    });
  }

  private getEnvInt(name: string, defaultValue: number): number {
    const raw = process.env[name];
    if (!raw) return defaultValue;
    const n = Number(raw);
    if (!Number.isFinite(n)) return defaultValue;
    return Math.trunc(n);
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async submitToAgent(
    tmuxSession: string,
    windowName: string,
    prompt: string,
    agentType: string,
  ): Promise<void> {
    this.deps.runtime.typeKeysToWindow(tmuxSession, windowName, prompt.trimEnd(), agentType);
    const envKey =
      agentType === 'opencode'
        ? 'DISCODE_OPENCODE_SUBMIT_DELAY_MS'
        : 'DISCODE_SUBMIT_DELAY_MS';
    const defaultMs = agentType === 'opencode' ? 75 : 300;
    const delayMs = this.getEnvInt(envKey, defaultMs);
    await this.sleep(delayMs);
    this.deps.runtime.sendEnterToWindow(tmuxSession, windowName, agentType);
  }

  private async executeShellCommand(command: string, projectPath: string, channelId: string): Promise<void> {
    const { messaging } = this.deps;
    let output: string;

    try {
      output = execSync(command, {
        cwd: projectPath,
        timeout: 30_000,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      const exitCode = err.status ?? 1;
      const combined = ((err.stdout || '') + (err.stderr || '')).trim();
      const errorMsg = combined.length > 0
        ? `⚠️ Exit code ${exitCode}\n\`\`\`\n${combined}\n\`\`\``
        : `⚠️ Exit code ${exitCode} (no output)`;

      await this.sendShellChunks(channelId, errorMsg);
      return;
    }

    const trimmed = output.trim();
    if (trimmed.length === 0) {
      await messaging.sendToChannel(channelId, '✅ (no output)');
      return;
    }

    await this.sendShellChunks(channelId, `\`\`\`\n${trimmed}\n\`\`\``);
  }

  private async sendShellChunks(channelId: string, text: string): Promise<void> {
    const maxLen = this.deps.messaging.platform === 'slack' ? 3900 : 1900;

    if (text.length <= maxLen) {
      await this.deps.messaging.sendToChannel(channelId, text);
      return;
    }

    const lines = text.split('\n');
    let current = '';
    for (const line of lines) {
      if (current.length + line.length + 1 > maxLen) {
        if (current) await this.deps.messaging.sendToChannel(channelId, current);
        current = line;
      } else {
        current += (current ? '\n' : '') + line;
      }
    }
    if (current) await this.deps.messaging.sendToChannel(channelId, current);
  }

  private buildDeliveryFailureGuidance(projectName: string, error: unknown): string {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const missingTarget = /can't find (window|pane)/i.test(rawMessage);

    if (missingTarget) {
      return (
        `⚠️ I couldn't deliver your message because the agent tmux window is not running.\n` +
        `Please restart the agent session, then send your message again:\n` +
        `1) \`discode new --name ${projectName}\`\n` +
        `2) \`discode attach ${projectName}\``
      );
    }

    return (
      `⚠️ I couldn't deliver your message to the tmux agent session.\n` +
      `Please confirm the agent is running, then try again.\n` +
      `If needed, restart with \`discode new --name ${projectName}\`.`
    );
  }
}
