import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PendingMessageTracker, type PendingEntry } from '../../src/bridge/pending-message-tracker.js';
import type { MessagingClient } from '../../src/messaging/interface.js';

function createMockMessaging(): Partial<MessagingClient> {
  return {
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    sendToChannelWithId: vi.fn().mockResolvedValue('start-msg-123'),
  };
}

describe('PendingMessageTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves pending entry', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');

    const entry = tracker.getPending('proj', 'claude');
    expect(entry).toBeDefined();
    expect(entry!.channelId).toBe('ch-1');
    expect(entry!.messageId).toBe('msg-1');
    // startMessageId is not set until ensureStartMessage is called
    expect(entry!.startMessageId).toBeUndefined();
  });

  it('returns undefined for unknown key', () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);
    expect(tracker.getPending('proj', 'claude')).toBeUndefined();
  });

  it('markCompleted removes pending entry', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');
    expect(tracker.hasPending('proj', 'claude')).toBe(true);

    await tracker.markCompleted('proj', 'claude');
    expect(tracker.hasPending('proj', 'claude')).toBe(false);
  });

  it('markCompleted replaces reaction', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');
    await tracker.markCompleted('proj', 'claude');

    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith('ch-1', 'msg-1', '⏳', '✅');
  });

  it('getPending returns recently-completed entry after markCompleted', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');
    await tracker.ensureStartMessage('proj', 'claude');
    await tracker.markCompleted('proj', 'claude');

    // hasPending is false (active map is cleared)
    expect(tracker.hasPending('proj', 'claude')).toBe(false);

    // But getPending still returns it from recently-completed cache
    const entry = tracker.getPending('proj', 'claude');
    expect(entry).toBeDefined();
    expect(entry!.startMessageId).toBe('start-msg-123');
  });

  it('recently-completed entry expires after TTL', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');
    await tracker.markCompleted('proj', 'claude');

    // Still available immediately
    expect(tracker.getPending('proj', 'claude')).toBeDefined();

    // After TTL (30s), it expires
    vi.advanceTimersByTime(30_001);
    expect(tracker.getPending('proj', 'claude')).toBeUndefined();
  });

  it('markPending clears stale recently-completed entry', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');
    await tracker.markCompleted('proj', 'claude');

    // New pending for the same key should clear the recently-completed entry
    (messaging.sendToChannelWithId as ReturnType<typeof vi.fn>).mockResolvedValue('start-msg-456');
    await tracker.markPending('proj', 'claude', 'ch-2', 'msg-2');
    await tracker.ensureStartMessage('proj', 'claude');

    const entry = tracker.getPending('proj', 'claude');
    expect(entry!.channelId).toBe('ch-2');
    expect(entry!.startMessageId).toBe('start-msg-456');
  });

  it('uses instanceId for pending key when provided', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1', 'inst-A');
    await tracker.markPending('proj', 'claude', 'ch-2', 'msg-2', 'inst-B');

    expect(tracker.getPending('proj', 'claude', 'inst-A')!.channelId).toBe('ch-1');
    expect(tracker.getPending('proj', 'claude', 'inst-B')!.channelId).toBe('ch-2');
  });

  it('markError removes pending entry without recently-completed cache', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');
    await tracker.markError('proj', 'claude');

    expect(tracker.hasPending('proj', 'claude')).toBe(false);
    // markError does not cache in recently-completed
    expect(tracker.getPending('proj', 'claude')).toBeUndefined();
    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith('ch-1', 'msg-1', '⏳', '❌');
  });

  it('handles sendToChannelWithId not implemented', async () => {
    const messaging = createMockMessaging();
    delete (messaging as any).sendToChannelWithId;
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');

    const entry = tracker.getPending('proj', 'claude');
    expect(entry).toBeDefined();
    expect(entry!.startMessageId).toBeUndefined();
  });

  it('handles sendToChannelWithId failure gracefully', async () => {
    const messaging = createMockMessaging();
    (messaging.sendToChannelWithId as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'));
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');

    const entry = tracker.getPending('proj', 'claude');
    expect(entry).toBeDefined();
    expect(entry!.startMessageId).toBeUndefined();
  });

  // ── ensurePending ────────────────────────────────────────────────

  it('ensurePending creates pending entry with empty messageId', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.ensurePending('proj', 'claude', 'ch-1');

    const entry = tracker.getPending('proj', 'claude');
    expect(entry).toBeDefined();
    expect(entry!.channelId).toBe('ch-1');
    expect(entry!.messageId).toBe('');
    // startMessageId is not set until ensureStartMessage is called
    expect(entry!.startMessageId).toBeUndefined();
  });

  it('ensureStartMessage skips generic start message for tmux pending without preview', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.ensurePending('proj', 'claude', 'ch-1');
    // ensurePending does NOT send Prompt message
    expect(messaging.sendToChannelWithId).not.toHaveBeenCalled();
    // Should NOT add reaction (no user message)
    expect(messaging.addReactionToMessage).not.toHaveBeenCalled();

    // ensureStartMessage does not send generic marker when preview is unknown
    const startId = await tracker.ensureStartMessage('proj', 'claude');
    expect(startId).toBeUndefined();
    expect(messaging.sendToChannelWithId).not.toHaveBeenCalled();
  });

  it('ensurePending does not duplicate when already pending', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');
    (messaging.sendToChannelWithId as ReturnType<typeof vi.fn>).mockClear();

    await tracker.ensurePending('proj', 'claude', 'ch-1');

    // Should not send another Prompt message
    expect(messaging.sendToChannelWithId).not.toHaveBeenCalled();
    // Original entry preserved
    expect(tracker.getPending('proj', 'claude')!.messageId).toBe('msg-1');
  });

  it('ensurePending clears recentlyCompleted and creates new entry', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');
    await tracker.markCompleted('proj', 'claude');

    // Now recentlyCompleted has the old entry
    expect(tracker.hasPending('proj', 'claude')).toBe(false);

    (messaging.sendToChannelWithId as ReturnType<typeof vi.fn>).mockResolvedValue('start-msg-new');
    await tracker.ensurePending('proj', 'claude', 'ch-1');

    // New pending entry
    expect(tracker.hasPending('proj', 'claude')).toBe(true);
    const entry = tracker.getPending('proj', 'claude');
    expect(entry!.messageId).toBe('');
    // startMessageId is deferred until ensureStartMessage
    expect(entry!.startMessageId).toBeUndefined();

    tracker.setPromptPreview('proj', 'claude', 'new tmux prompt');
    await tracker.ensureStartMessage('proj', 'claude');
    expect(tracker.getPending('proj', 'claude')!.startMessageId).toBe('start-msg-new');
  });

  it('ensurePending with instanceId', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.ensurePending('proj', 'claude', 'ch-1', 'inst-A');
    expect(tracker.getPending('proj', 'claude', 'inst-A')).toBeDefined();
    expect(tracker.getPending('proj', 'claude')).toBeUndefined();
  });

  it('markCompleted skips reaction for ensurePending entries (empty messageId)', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.ensurePending('proj', 'claude', 'ch-1');
    await tracker.markCompleted('proj', 'claude');

    expect(messaging.replaceOwnReactionOnMessage).not.toHaveBeenCalled();
  });

  it('markError skips reaction for ensurePending entries (empty messageId)', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.ensurePending('proj', 'claude', 'ch-1');
    await tracker.markError('proj', 'claude');

    expect(messaging.replaceOwnReactionOnMessage).not.toHaveBeenCalled();
  });

  it('ensurePending handles sendToChannelWithId not implemented', async () => {
    const messaging = createMockMessaging();
    delete (messaging as any).sendToChannelWithId;
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.ensurePending('proj', 'claude', 'ch-1');

    const entry = tracker.getPending('proj', 'claude');
    expect(entry).toBeDefined();
    expect(entry!.startMessageId).toBeUndefined();
  });

  it('ensurePending handles sendToChannelWithId failure gracefully', async () => {
    const messaging = createMockMessaging();
    (messaging.sendToChannelWithId as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'));
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.ensurePending('proj', 'claude', 'ch-1');

    const entry = tracker.getPending('proj', 'claude');
    expect(entry).toBeDefined();
    expect(entry!.channelId).toBe('ch-1');
    expect(entry!.messageId).toBe('');
    expect(entry!.startMessageId).toBeUndefined();
  });

  // ── hookActive ──────────────────────────────────────────────────

  it('setHookActive marks pending entry as hook-active', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');
    expect(tracker.isHookActive('proj', 'claude')).toBe(false);

    tracker.setHookActive('proj', 'claude');
    expect(tracker.isHookActive('proj', 'claude')).toBe(true);
  });

  it('isHookActive returns false when no pending entry', () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    expect(tracker.isHookActive('proj', 'claude')).toBe(false);
  });

  it('setHookActive is no-op when no pending entry', () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    // Should not throw
    tracker.setHookActive('proj', 'claude');
    expect(tracker.isHookActive('proj', 'claude')).toBe(false);
  });

  it('hookActive flag is cleared when markCompleted removes pending entry', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');
    tracker.setHookActive('proj', 'claude');
    expect(tracker.isHookActive('proj', 'claude')).toBe(true);

    await tracker.markCompleted('proj', 'claude');
    // Active map is cleared, so isHookActive should return false
    expect(tracker.isHookActive('proj', 'claude')).toBe(false);
  });

  it('hookActive flag is cleared when markPending replaces entry', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');
    tracker.setHookActive('proj', 'claude');

    // New markPending creates a fresh entry without hookActive
    await tracker.markPending('proj', 'claude', 'ch-2', 'msg-2');
    expect(tracker.isHookActive('proj', 'claude')).toBe(false);
  });

  it('setHookActive with instanceId', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1', 'inst-A');
    await tracker.markPending('proj', 'claude', 'ch-2', 'msg-2', 'inst-B');

    tracker.setHookActive('proj', 'claude', 'inst-A');
    expect(tracker.isHookActive('proj', 'claude', 'inst-A')).toBe(true);
    expect(tracker.isHookActive('proj', 'claude', 'inst-B')).toBe(false);
  });

  it('ensurePending entry stays in recentlyCompleted after markCompleted', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.ensurePending('proj', 'claude', 'ch-1');
    tracker.setPromptPreview('proj', 'claude', 'prompt turn1');
    await tracker.ensureStartMessage('proj', 'claude');
    await tracker.markCompleted('proj', 'claude');

    expect(tracker.hasPending('proj', 'claude')).toBe(false);
    const entry = tracker.getPending('proj', 'claude');
    expect(entry).toBeDefined();
    expect(entry!.startMessageId).toBe('start-msg-123');
  });

  it('consecutive tmux turns: ensurePending after markCompleted creates new entry', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    // Turn 1
    await tracker.ensurePending('proj', 'claude', 'ch-1');
    tracker.setPromptPreview('proj', 'claude', 'prompt turn1');
    await tracker.ensureStartMessage('proj', 'claude');
    await tracker.markCompleted('proj', 'claude');
    expect(tracker.hasPending('proj', 'claude')).toBe(false);

    // Turn 2 — new ensurePending should work despite recentlyCompleted
    (messaging.sendToChannelWithId as ReturnType<typeof vi.fn>).mockResolvedValue('start-msg-turn2');
    await tracker.ensurePending('proj', 'claude', 'ch-1');
    tracker.setPromptPreview('proj', 'claude', 'prompt turn2');
    await tracker.ensureStartMessage('proj', 'claude');

    expect(tracker.hasPending('proj', 'claude')).toBe(true);
    const entry = tracker.getPending('proj', 'claude');
    expect(entry!.startMessageId).toBe('start-msg-turn2');
  });

  it('ensurePending recentlyCompleted TTL cleared when creating new entry', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.ensurePending('proj', 'claude', 'ch-1');
    tracker.setPromptPreview('proj', 'claude', 'prompt turn1');
    await tracker.ensureStartMessage('proj', 'claude');
    await tracker.markCompleted('proj', 'claude');

    // recentlyCompleted exists
    expect(tracker.getPending('proj', 'claude')).toBeDefined();

    // New ensurePending clears old recentlyCompleted timer
    (messaging.sendToChannelWithId as ReturnType<typeof vi.fn>).mockResolvedValue('start-new');
    await tracker.ensurePending('proj', 'claude', 'ch-1');
    tracker.setPromptPreview('proj', 'claude', 'prompt turn2');
    await tracker.ensureStartMessage('proj', 'claude');

    // Advance past old TTL — should not expire the new active entry
    vi.advanceTimersByTime(31_000);
    expect(tracker.hasPending('proj', 'claude')).toBe(true);
    expect(tracker.getPending('proj', 'claude')!.startMessageId).toBe('start-new');
  });

  it('buffer fallback then stop hook: thread replies still work', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    // 1. User sends message → markPending + ensureStartMessage
    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');
    await tracker.ensureStartMessage('proj', 'claude');
    expect(tracker.getPending('proj', 'claude')!.startMessageId).toBe('start-msg-123');

    // 2. Buffer fallback fires → markCompleted
    await tracker.markCompleted('proj', 'claude');
    expect(tracker.hasPending('proj', 'claude')).toBe(false);

    // 3. Stop hook fires → getPending should still return entry for thread replies
    const pending = tracker.getPending('proj', 'claude');
    expect(pending).toBeDefined();
    expect(pending!.startMessageId).toBe('start-msg-123');
    expect(pending!.channelId).toBe('ch-1');
  });

  // ── ensureStartMessage ──────────────────────────────────────────

  it('ensureStartMessage returns undefined when no pending entry', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    const result = await tracker.ensureStartMessage('proj', 'claude');
    expect(result).toBeUndefined();
    expect(messaging.sendToChannelWithId).not.toHaveBeenCalled();
  });

  it('ensureStartMessage creates start message and stores ID', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');
    const startId = await tracker.ensureStartMessage('proj', 'claude');

    expect(startId).toBe('start-msg-123');
    expect(messaging.sendToChannelWithId).toHaveBeenCalledWith('ch-1', '📝 Prompt (claude)');
    expect(tracker.getPending('proj', 'claude')!.startMessageId).toBe('start-msg-123');
  });

  it('ensureStartMessage includes submitted prompt preview when provided', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');
    await tracker.ensureStartMessage('proj', 'claude', undefined, '확인메세지');

    expect(messaging.sendToChannelWithId).toHaveBeenCalledWith('ch-1', '📝 Prompt: 확인메세지');
  });

  it('ensureStartMessage uses stored prompt preview when provided earlier', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');
    tracker.setPromptPreview('proj', 'claude', 'router prompt text');
    await tracker.ensureStartMessage('proj', 'claude');

    expect(messaging.sendToChannelWithId).toHaveBeenCalledWith('ch-1', '📝 Prompt: router prompt text');
  });

  it('ensureStartMessage keeps submitted prompt text as-is', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');
    await tracker.ensureStartMessage('proj', 'claude', undefined, 'line 1\nline 2');

    expect(messaging.sendToChannelWithId).toHaveBeenCalledWith('ch-1', '📝 Prompt: line 1\nline 2');
  });

  it('ensureStartMessage is idempotent — returns existing ID on second call', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');
    const first = await tracker.ensureStartMessage('proj', 'claude');
    const second = await tracker.ensureStartMessage('proj', 'claude');

    expect(first).toBe('start-msg-123');
    expect(second).toBe('start-msg-123');
    // Only one call to sendToChannelWithId
    expect(messaging.sendToChannelWithId).toHaveBeenCalledTimes(1);
  });

  it('ensureStartMessage handles sendToChannelWithId not implemented', async () => {
    const messaging = createMockMessaging();
    delete (messaging as any).sendToChannelWithId;
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');
    const result = await tracker.ensureStartMessage('proj', 'claude');

    expect(result).toBeUndefined();
  });

  it('ensureStartMessage handles sendToChannelWithId failure gracefully', async () => {
    const messaging = createMockMessaging();
    (messaging.sendToChannelWithId as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'));
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1');
    const result = await tracker.ensureStartMessage('proj', 'claude');

    expect(result).toBeUndefined();
    // Entry still exists, just without startMessageId
    expect(tracker.hasPending('proj', 'claude')).toBe(true);
  });

  it('ensureStartMessage skips generic prompt for tmux pending without preview', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.ensurePending('proj', 'codex', 'ch-1');
    const result = await tracker.ensureStartMessage('proj', 'codex');

    expect(result).toBeUndefined();
    expect(messaging.sendToChannelWithId).not.toHaveBeenCalled();
  });

  it('ensureStartMessage uses instanceId for key when provided', async () => {
    const messaging = createMockMessaging();
    (messaging.sendToChannelWithId as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('start-A')
      .mockResolvedValueOnce('start-B');
    const tracker = new PendingMessageTracker(messaging as MessagingClient);

    await tracker.markPending('proj', 'claude', 'ch-1', 'msg-1', 'inst-A');
    await tracker.markPending('proj', 'claude', 'ch-2', 'msg-2', 'inst-B');

    const startA = await tracker.ensureStartMessage('proj', 'claude', 'inst-A');
    const startB = await tracker.ensureStartMessage('proj', 'claude', 'inst-B');

    expect(startA).toBe('start-A');
    expect(startB).toBe('start-B');
  });
});
