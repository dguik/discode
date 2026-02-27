import type { MessagingClient } from '../messaging/interface.js';

export interface PendingEntry {
  channelId: string;
  messageId: string;
  startMessageId?: string;
  hookActive?: boolean;
}

export class PendingMessageTracker {
  private pendingMessageByInstance: Map<string, PendingEntry> = new Map();
  // Recently completed entries — kept briefly so the Stop hook can still
  // retrieve startMessageId for thread replies after the buffer fallback
  // has already called markCompleted.
  private recentlyCompleted: Map<string, { entry: PendingEntry; timer: ReturnType<typeof setTimeout> }> = new Map();
  private static RECENTLY_COMPLETED_TTL_MS = 30_000;

  constructor(private messaging: MessagingClient) {}

  private pendingKey(projectName: string, instanceKey: string): string {
    return `${projectName}:${instanceKey}`;
  }

  async markPending(
    projectName: string,
    agentType: string,
    channelId: string,
    messageId: string,
    instanceId?: string,
  ): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);

    // Clear any stale recently-completed entry for this key
    const recent = this.recentlyCompleted.get(key);
    if (recent) {
      clearTimeout(recent.timer);
      this.recentlyCompleted.delete(key);
    }

    // Add reaction to user's message
    await this.messaging.addReactionToMessage(channelId, messageId, '⏳');

    // Store pending entry WITHOUT start message — deferred until first activity
    this.pendingMessageByInstance.set(key, { channelId, messageId });
  }

  /**
   * Ensure a pending entry exists for this instance.
   * Used for tmux-initiated prompts that bypass the normal Slack message flow.
   * Does not add a reaction (no user message to react to).
   * The start message is created lazily via ensureStartMessage().
   */
  async ensurePending(
    projectName: string,
    agentType: string,
    channelId: string,
    instanceId?: string,
  ): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);

    // Already actively pending — don't duplicate
    if (this.pendingMessageByInstance.has(key)) return;

    // Clear any stale recently-completed entry for this key
    const recent = this.recentlyCompleted.get(key);
    if (recent) {
      clearTimeout(recent.timer);
      this.recentlyCompleted.delete(key);
    }

    // Store pending entry WITHOUT start message — deferred until first activity
    this.pendingMessageByInstance.set(key, { channelId, messageId: '' });
  }

  /**
   * Create the "📝 Prompt" start message for this pending entry.
   * Called either immediately on user prompt submit or lazily on first activity
   * for tmux-initiated turns.
   * Returns the startMessageId if created or already exists.
   */
  async ensureStartMessage(
    projectName: string,
    agentType: string,
    instanceId?: string,
    promptPreview?: string,
  ): Promise<string | undefined> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const pending = this.pendingMessageByInstance.get(key);
    if (!pending) return undefined;

    // Already has a start message
    if (pending.startMessageId) return pending.startMessageId;

    if (this.messaging.sendToChannelWithId) {
      try {
        pending.startMessageId = await this.messaging.sendToChannelWithId(
          pending.channelId,
          this.formatStartMessage(agentType, promptPreview),
        );
      } catch {
        // Non-fatal
      }
    }

    return pending.startMessageId;
  }

  async markCompleted(projectName: string, agentType: string, instanceId?: string): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const pending = this.pendingMessageByInstance.get(key);
    if (!pending) return;

    if (pending.messageId) {
      await this.messaging.replaceOwnReactionOnMessage(pending.channelId, pending.messageId, '⏳', '✅');
    }
    this.pendingMessageByInstance.delete(key);

    // Keep the entry in recently-completed so the Stop hook can still use
    // startMessageId for thread replies if it arrives after the buffer fallback.
    const existing = this.recentlyCompleted.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => this.recentlyCompleted.delete(key), PendingMessageTracker.RECENTLY_COMPLETED_TTL_MS);
    this.recentlyCompleted.set(key, { entry: pending, timer });
  }

  async markError(projectName: string, agentType: string, instanceId?: string): Promise<void> {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const pending = this.pendingMessageByInstance.get(key);
    if (!pending) return;

    if (pending.messageId) {
      await this.messaging.replaceOwnReactionOnMessage(pending.channelId, pending.messageId, '⏳', '❌');
    }
    this.pendingMessageByInstance.delete(key);
  }

  hasPending(projectName: string, agentType: string, instanceId?: string): boolean {
    const key = this.pendingKey(projectName, instanceId || agentType);
    return this.pendingMessageByInstance.has(key);
  }

  getPending(projectName: string, agentType: string, instanceId?: string): PendingEntry | undefined {
    const key = this.pendingKey(projectName, instanceId || agentType);
    return this.pendingMessageByInstance.get(key) || this.recentlyCompleted.get(key)?.entry;
  }

  setHookActive(projectName: string, agentType: string, instanceId?: string): void {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const pending = this.pendingMessageByInstance.get(key);
    if (pending) {
      pending.hookActive = true;
    }
  }

  isHookActive(projectName: string, agentType: string, instanceId?: string): boolean {
    const key = this.pendingKey(projectName, instanceId || agentType);
    const pending = this.pendingMessageByInstance.get(key);
    return pending?.hookActive === true;
  }

  private formatStartMessage(agentType: string, promptPreview?: string): string {
    const normalized = (promptPreview ?? '').trim().replace(/\s+/g, ' ');
    if (normalized.length > 0) {
      const MAX_PREVIEW = 160;
      const preview = normalized.length > MAX_PREVIEW
        ? `${normalized.slice(0, MAX_PREVIEW - 1)}…`
        : normalized;
      return `📝 Prompt: ${preview}`;
    }

    const agentSuffix = agentType ? ` (${agentType})` : '';
    return `📝 Prompt${agentSuffix}`;
  }
}
