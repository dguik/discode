/**
 * Tests for PendingMessageTracker reaction lifecycle (⏳ → ✅ / ❌).
 */

import { describe, expect, it, vi } from 'vitest';
import { PendingMessageTracker } from '../../src/bridge/pending-message-tracker.js';

// ── Helpers ─────────────────────────────────────────────────────────

function createMockMessaging() {
  return {
    platform: 'discord' as const,
    onMessage: vi.fn(),
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    replyInThreadWithId: vi.fn().mockResolvedValue('thread-msg-ts'),
    updateMessage: vi.fn().mockResolvedValue(undefined),
  };
}

// ── PendingMessageTracker tests ────────────────────────────────────

describe('PendingMessageTracker', () => {
  it('adds ⏳ reaction when marking message as pending', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as any);

    await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');

    expect(messaging.addReactionToMessage).toHaveBeenCalledWith('ch-1', 'msg-1', '⏳');
  });

  it('replaces ⏳ with ✅ on markCompleted', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as any);

    await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');
    await tracker.markCompleted('project', 'claude');

    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith('ch-1', 'msg-1', '⏳', '✅');
  });

  it('replaces ⏳ with ❌ on markError', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as any);

    await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');
    await tracker.markError('project', 'claude');

    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith('ch-1', 'msg-1', '⏳', '❌');
  });

  it('silently ignores markCompleted when no pending message', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as any);

    await tracker.markCompleted('project', 'claude');

    expect(messaging.replaceOwnReactionOnMessage).not.toHaveBeenCalled();
  });

  it('silently ignores markError when no pending message', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as any);

    await tracker.markError('project', 'claude');

    expect(messaging.replaceOwnReactionOnMessage).not.toHaveBeenCalled();
  });

  it('tracks multiple projects independently', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as any);

    await tracker.markPending('project-a', 'claude', 'ch-a', 'msg-a');
    await tracker.markPending('project-b', 'claude', 'ch-b', 'msg-b');

    await tracker.markCompleted('project-a', 'claude');

    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith('ch-a', 'msg-a', '⏳', '✅');
    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenCalledTimes(1);
  });

  it('overwrites pending when new message arrives before completion', async () => {
    const messaging = createMockMessaging();
    const tracker = new PendingMessageTracker(messaging as any);

    await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');
    await tracker.markPending('project', 'claude', 'ch-1', 'msg-2');

    // Complete the second message
    await tracker.markCompleted('project', 'claude');

    expect(messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith('ch-1', 'msg-2', '⏳', '✅');
  });

  it('propagates error when addReactionToMessage throws', async () => {
    const messaging = createMockMessaging();
    messaging.addReactionToMessage.mockRejectedValue(new Error('API error'));
    const tracker = new PendingMessageTracker(messaging as any);

    await expect(tracker.markPending('project', 'claude', 'ch-1', 'msg-1')).rejects.toThrow('API error');
  });

  it('propagates error when replaceOwnReactionOnMessage throws', async () => {
    const messaging = createMockMessaging();
    messaging.replaceOwnReactionOnMessage.mockRejectedValue(new Error('API error'));
    const tracker = new PendingMessageTracker(messaging as any);

    await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');
    await expect(tracker.markCompleted('project', 'claude')).rejects.toThrow('API error');
  });

  describe('getPending', () => {
    it('returns pending entry when it exists', async () => {
      const messaging = createMockMessaging();
      const tracker = new PendingMessageTracker(messaging as any);

      await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');

      const pending = tracker.getPending('project', 'claude');
      expect(pending).toBeDefined();
      expect(pending?.channelId).toBe('ch-1');
      expect(pending?.messageId).toBe('msg-1');
    });

    it('returns undefined when no pending entry', () => {
      const messaging = createMockMessaging();
      const tracker = new PendingMessageTracker(messaging as any);

      expect(tracker.getPending('project', 'claude')).toBeUndefined();
    });

    it('returns recently-completed entry after markCompleted (kept for stop-hook)', async () => {
      const messaging = createMockMessaging();
      const tracker = new PendingMessageTracker(messaging as any);

      await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');
      await tracker.markCompleted('project', 'claude');

      // getPending checks recentlyCompleted so the Stop hook can still
      // retrieve startMessageId for thread replies after buffer fallback.
      const entry = tracker.getPending('project', 'claude');
      expect(entry).toBeDefined();
      expect(entry?.channelId).toBe('ch-1');
      expect(entry?.messageId).toBe('msg-1');
    });

    it('returns undefined after markError', async () => {
      const messaging = createMockMessaging();
      const tracker = new PendingMessageTracker(messaging as any);

      await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');
      await tracker.markError('project', 'claude');

      expect(tracker.getPending('project', 'claude')).toBeUndefined();
    });

    it('returns the most recent pending entry after overwrite', async () => {
      const messaging = createMockMessaging();
      const tracker = new PendingMessageTracker(messaging as any);

      await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');
      await tracker.markPending('project', 'claude', 'ch-1', 'msg-2');

      const pending = tracker.getPending('project', 'claude');
      expect(pending?.messageId).toBe('msg-2');
    });

    it('returns pending for default instanceId', async () => {
      const messaging = createMockMessaging();
      const tracker = new PendingMessageTracker(messaging as any);

      await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');

      // getPending with explicit default instanceId should work
      const pending = tracker.getPending('project', 'claude', 'claude');
      expect(pending).toBeDefined();
      expect(pending?.messageId).toBe('msg-1');
    });

    it('distinguishes between different instanceIds', async () => {
      const messaging = createMockMessaging();
      const tracker = new PendingMessageTracker(messaging as any);

      await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');
      await tracker.markPending('project', 'claude', 'ch-2', 'msg-2', 'claude-2');

      expect(tracker.getPending('project', 'claude', 'claude')?.messageId).toBe('msg-1');
      expect(tracker.getPending('project', 'claude', 'claude-2')?.messageId).toBe('msg-2');
    });
  });

  describe('hasPending', () => {
    it('returns true when pending entry exists', async () => {
      const messaging = createMockMessaging();
      const tracker = new PendingMessageTracker(messaging as any);

      await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');

      expect(tracker.hasPending('project', 'claude')).toBe(true);
    });

    it('returns false when no pending entry', () => {
      const messaging = createMockMessaging();
      const tracker = new PendingMessageTracker(messaging as any);

      expect(tracker.hasPending('project', 'claude')).toBe(false);
    });

    it('returns false after markCompleted', async () => {
      const messaging = createMockMessaging();
      const tracker = new PendingMessageTracker(messaging as any);

      await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');
      await tracker.markCompleted('project', 'claude');

      expect(tracker.hasPending('project', 'claude')).toBe(false);
    });

    it('distinguishes between different instanceIds', async () => {
      const messaging = createMockMessaging();
      const tracker = new PendingMessageTracker(messaging as any);

      await tracker.markPending('project', 'claude', 'ch-1', 'msg-1');
      await tracker.markPending('project', 'claude', 'ch-2', 'msg-2', 'claude-2');

      await tracker.markCompleted('project', 'claude', 'claude');

      expect(tracker.hasPending('project', 'claude', 'claude')).toBe(false);
      expect(tracker.hasPending('project', 'claude', 'claude-2')).toBe(true);
    });
  });
});
