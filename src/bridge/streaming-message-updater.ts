import type { MessagingClient } from '../messaging/interface.js';

interface StreamingEntry {
  channelId: string;
  messageId: string;
  /** The latest status text to display (replaces previous on each update). */
  currentText: string;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** Promise for any in-progress flush (prevents finalize from racing). */
  flushPromise?: Promise<void>;
}

const DEBOUNCE_MS = 750;

export class StreamingMessageUpdater {
  private entries = new Map<string, StreamingEntry>();

  constructor(private messaging: MessagingClient) {}

  private key(projectName: string, instanceKey: string): string {
    return `${projectName}:${instanceKey}`;
  }

  canStream(): boolean {
    return typeof this.messaging.updateMessage === 'function';
  }

  start(projectName: string, instanceKey: string, channelId: string, messageId: string): void {
    if (!this.canStream()) return;
    const k = this.key(projectName, instanceKey);

    // Discard any previous entry for this key
    const existing = this.entries.get(k);
    if (existing?.debounceTimer) clearTimeout(existing.debounceTimer);

    this.entries.set(k, {
      channelId,
      messageId,
      currentText: '',
      debounceTimer: null,
    });
  }

  /**
   * Replace the displayed status text with the latest activity.
   * Returns true if updated successfully, false if not streaming.
   */
  append(projectName: string, instanceKey: string, text: string): boolean {
    const k = this.key(projectName, instanceKey);
    const entry = this.entries.get(k);
    if (!entry) return false;

    entry.currentText = text;

    // Reset debounce timer
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      this.flush(k).catch(() => {});
    }, DEBOUNCE_MS);

    return true;
  }

  /**
   * Finalize the streaming message: change to "Done" (or custom header) and flush immediately.
   * If expectedMessageId is provided, only finalize if the entry still belongs to the same request
   * (prevents a stale handler from finalizing a newer request's entry after markPending overwrites).
   */
  async finalize(projectName: string, instanceKey: string, customHeader?: string, expectedMessageId?: string): Promise<void> {
    const k = this.key(projectName, instanceKey);
    const entry = this.entries.get(k);
    if (!entry) return;

    // Guard: if a newer request took over this streaming slot, don't finalize it
    if (expectedMessageId && entry.messageId !== expectedMessageId) return;

    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);

    // Wait for any in-progress flush to complete so our update is always last
    if (entry.flushPromise) await entry.flushPromise;

    const content = customHeader || '\u2705 Done';
    this.entries.delete(k);

    if (this.messaging.updateMessage) {
      try {
        await this.messaging.updateMessage(entry.channelId, entry.messageId, content);
      } catch {
        // Non-fatal
      }
    }
  }

  discard(projectName: string, instanceKey: string): void {
    const k = this.key(projectName, instanceKey);
    const entry = this.entries.get(k);
    if (!entry) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    this.entries.delete(k);
  }

  has(projectName: string, instanceKey: string): boolean {
    return this.entries.has(this.key(projectName, instanceKey));
  }

  private async flush(k: string): Promise<void> {
    const entry = this.entries.get(k);
    if (!entry) return;

    const content = entry.currentText || '\u23F3 Working...';
    if (this.messaging.updateMessage) {
      const promise = this.messaging.updateMessage(entry.channelId, entry.messageId, content).catch(() => {});
      entry.flushPromise = promise;
      await promise;
      // Clear only if this is still the active flush
      if (entry.flushPromise === promise) entry.flushPromise = undefined;
    }
  }
}
