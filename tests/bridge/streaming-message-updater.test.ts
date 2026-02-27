import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingMessageUpdater } from '../../src/bridge/streaming-message-updater.js';

function createMockMessaging(withUpdateMessage = true) {
  return {
    platform: 'slack' as const,
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    sendToChannelWithId: vi.fn().mockResolvedValue('start-msg-ts'),
    sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    replyInThread: vi.fn().mockResolvedValue(undefined),
    ...(withUpdateMessage ? { updateMessage: vi.fn().mockResolvedValue(undefined) } : {}),
  };
}

describe('StreamingMessageUpdater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('canStream', () => {
    it('returns true when messaging has updateMessage', () => {
      const messaging = createMockMessaging(true);
      const updater = new StreamingMessageUpdater(messaging as any);
      expect(updater.canStream()).toBe(true);
    });

    it('returns false when messaging lacks updateMessage', () => {
      const messaging = createMockMessaging(false);
      const updater = new StreamingMessageUpdater(messaging as any);
      expect(updater.canStream()).toBe(false);
    });
  });

  describe('start / has', () => {
    it('creates an entry', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);

      expect(updater.has('proj', 'inst')).toBe(false);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      expect(updater.has('proj', 'inst')).toBe(true);
    });

    it('replaces an existing entry', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);

      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      updater.append('proj', 'inst', 'old status');
      updater.start('proj', 'inst', 'ch-2', 'msg-2');

      // Old text should be gone after restart
      updater.append('proj', 'inst', 'new status');
      vi.advanceTimersByTime(800);

      expect(messaging.updateMessage).toHaveBeenCalledWith(
        'ch-2',
        'msg-2',
        'new status',
      );
    });
  });

  describe('append', () => {
    it('returns false when no active entry', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      expect(updater.append('proj', 'inst', 'text')).toBe(false);
    });

    it('replaces previous text and debounces updateMessage', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');

      expect(updater.append('proj', 'inst', 'status 1')).toBe(true);
      expect(updater.append('proj', 'inst', 'status 2')).toBe(true);

      // Not flushed yet (within debounce window)
      expect(messaging.updateMessage).not.toHaveBeenCalled();

      // After debounce period — only shows latest status
      vi.advanceTimersByTime(800);

      expect(messaging.updateMessage).toHaveBeenCalledTimes(1);
      expect(messaging.updateMessage).toHaveBeenCalledWith(
        'ch-1',
        'msg-1',
        'status 2',
      );
    });

    it('resets debounce timer on each append', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');

      updater.append('proj', 'inst', 'status 1');
      vi.advanceTimersByTime(500); // not yet
      updater.append('proj', 'inst', 'status 2');
      vi.advanceTimersByTime(500); // still not yet (reset)

      expect(messaging.updateMessage).not.toHaveBeenCalled();

      vi.advanceTimersByTime(300); // now 750ms since last append
      expect(messaging.updateMessage).toHaveBeenCalledTimes(1);
    });

    it('shows Processing header when flushed with no text', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');

      updater.append('proj', 'inst', '');
      vi.advanceTimersByTime(800);

      expect(messaging.updateMessage).toHaveBeenCalledWith(
        'ch-1',
        'msg-1',
        '\u23F3 Working...',
      );
    });
  });

  describe('finalize', () => {
    it('flushes immediately with Done header and removes entry', async () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      updater.append('proj', 'inst', 'tool 1');
      updater.append('proj', 'inst', 'tool 2');

      await updater.finalize('proj', 'inst');

      expect(messaging.updateMessage).toHaveBeenCalledTimes(1);
      expect(messaging.updateMessage).toHaveBeenCalledWith(
        'ch-1',
        'msg-1',
        '\u2705 Done',
      );
      expect(updater.has('proj', 'inst')).toBe(false);
    });

    it('cancels pending debounce timer', async () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      updater.append('proj', 'inst', 'tool 1');

      // Finalize before debounce fires
      await updater.finalize('proj', 'inst');

      // Advance past debounce — should not trigger extra update
      vi.advanceTimersByTime(1000);

      // Only the finalize call
      expect(messaging.updateMessage).toHaveBeenCalledTimes(1);
    });

    it('uses custom header when provided', async () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');

      await updater.finalize('proj', 'inst', '\u2705 Done \u00B7 1,000 tokens \u00B7 $0.05');

      expect(messaging.updateMessage).toHaveBeenCalledWith(
        'ch-1',
        'msg-1',
        '\u2705 Done \u00B7 1,000 tokens \u00B7 $0.05',
      );
    });

    it('handles no appends gracefully', async () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');

      await updater.finalize('proj', 'inst');

      expect(messaging.updateMessage).toHaveBeenCalledWith(
        'ch-1',
        'msg-1',
        '\u2705 Done',
      );
    });

    it('is a no-op when no entry exists', async () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);

      await updater.finalize('proj', 'inst');
      expect(messaging.updateMessage).not.toHaveBeenCalled();
    });

    it('skips finalize when expectedMessageId does not match', async () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');

      await updater.finalize('proj', 'inst', undefined, 'msg-other');

      expect(messaging.updateMessage).not.toHaveBeenCalled();
      expect(updater.has('proj', 'inst')).toBe(true);
    });
  });

  describe('start when canStream is false', () => {
    it('does not create an entry', () => {
      const messaging = createMockMessaging(false);
      const updater = new StreamingMessageUpdater(messaging as any);

      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      expect(updater.has('proj', 'inst')).toBe(false);
    });
  });

  describe('multiple instances', () => {
    it('tracks separate entries per project/instance', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);

      updater.start('proj-a', 'inst-1', 'ch-a', 'msg-a');
      updater.start('proj-b', 'inst-2', 'ch-b', 'msg-b');

      expect(updater.has('proj-a', 'inst-1')).toBe(true);
      expect(updater.has('proj-b', 'inst-2')).toBe(true);

      updater.discard('proj-a', 'inst-1');
      expect(updater.has('proj-a', 'inst-1')).toBe(false);
      expect(updater.has('proj-b', 'inst-2')).toBe(true);
    });
  });

  describe('error resilience', () => {
    it('flush handles updateMessage rejection gracefully', async () => {
      const messaging = createMockMessaging();
      messaging.updateMessage!.mockRejectedValue(new Error('Slack API error'));
      const updater = new StreamingMessageUpdater(messaging as any);

      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      updater.append('proj', 'inst', 'status');

      // Should not throw when debounce fires and updateMessage rejects
      vi.advanceTimersByTime(800);
      // Allow microtask queue to settle
      await vi.advanceTimersByTimeAsync(0);

      // Entry should still exist (flush failure doesn't destroy entry)
      expect(updater.has('proj', 'inst')).toBe(true);
    });

    it('finalize handles updateMessage rejection gracefully', async () => {
      const messaging = createMockMessaging();
      messaging.updateMessage!.mockRejectedValue(new Error('Slack API error'));
      const updater = new StreamingMessageUpdater(messaging as any);

      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      updater.append('proj', 'inst', 'status');

      // Should not throw
      await updater.finalize('proj', 'inst');
      expect(updater.has('proj', 'inst')).toBe(false);
    });
  });

  describe('flushPromise race condition', () => {
    it('finalize waits for in-progress flush before sending Done', async () => {
      let resolveFlush!: () => void;
      const messaging = createMockMessaging();
      // First call (flush) returns a pending promise; second call (finalize) resolves immediately
      messaging.updateMessage!
        .mockImplementationOnce(() => new Promise<void>((r) => { resolveFlush = r; }))
        .mockResolvedValueOnce(undefined);

      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      updater.append('proj', 'inst', 'tool activity');

      // Fire debounce → flush starts but is waiting on slow updateMessage
      vi.advanceTimersByTime(800);

      // Start finalize while flush is still pending
      const finalizePromise = updater.finalize('proj', 'inst');

      // At this point, flush's updateMessage is pending. Finalize should NOT have called yet.
      expect(messaging.updateMessage).toHaveBeenCalledTimes(1);
      expect(messaging.updateMessage).toHaveBeenCalledWith('ch-1', 'msg-1', 'tool activity');

      // Resolve the flush
      resolveFlush();
      await finalizePromise;

      // Now finalize's updateMessage should have been called AFTER flush completed
      expect(messaging.updateMessage).toHaveBeenCalledTimes(2);
      expect(messaging.updateMessage).toHaveBeenLastCalledWith('ch-1', 'msg-1', '\u2705 Done');
    });

    it('finalize proceeds when flush had rejected', async () => {
      const messaging = createMockMessaging();
      // flush rejects, finalize resolves
      messaging.updateMessage!
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce(undefined);

      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      updater.append('proj', 'inst', 'tool activity');

      // Fire debounce → flush starts and rejects
      vi.advanceTimersByTime(800);
      await vi.advanceTimersByTimeAsync(0);

      // Finalize should still work
      await updater.finalize('proj', 'inst');

      expect(messaging.updateMessage).toHaveBeenCalledTimes(2);
      expect(messaging.updateMessage).toHaveBeenLastCalledWith('ch-1', 'msg-1', '\u2705 Done');
      expect(updater.has('proj', 'inst')).toBe(false);
    });

    it('flushPromise is cleared after flush completes (no stale await)', async () => {
      const messaging = createMockMessaging();
      messaging.updateMessage!.mockResolvedValue(undefined);

      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      updater.append('proj', 'inst', 'first');

      // Fire debounce and let flush complete
      vi.advanceTimersByTime(800);
      await vi.advanceTimersByTimeAsync(0);

      expect(messaging.updateMessage).toHaveBeenCalledTimes(1);

      // Now finalize should NOT be blocked by a stale flushPromise
      await updater.finalize('proj', 'inst');

      expect(messaging.updateMessage).toHaveBeenCalledTimes(2);
      expect(messaging.updateMessage).toHaveBeenLastCalledWith('ch-1', 'msg-1', '\u2705 Done');
    });
  });

  describe('append after discard', () => {
    it('returns false after discard', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      updater.discard('proj', 'inst');

      expect(updater.append('proj', 'inst', 'late text')).toBe(false);
    });
  });

  describe('discard', () => {
    it('removes entry and cancels timer', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);
      updater.start('proj', 'inst', 'ch-1', 'msg-1');
      updater.append('proj', 'inst', 'tool 1');

      updater.discard('proj', 'inst');

      expect(updater.has('proj', 'inst')).toBe(false);

      // Advance past debounce — should not trigger update
      vi.advanceTimersByTime(1000);
      expect(messaging.updateMessage).not.toHaveBeenCalled();
    });

    it('is a no-op when no entry exists', () => {
      const messaging = createMockMessaging();
      const updater = new StreamingMessageUpdater(messaging as any);

      // Should not throw
      updater.discard('proj', 'inst');
    });
  });
});
