/**
 * Unit tests for the extracted message-buffer-fallback functions.
 *
 * Covers:
 * - captureWindowText: window frame / buffer capture with fallback
 * - extractLastCommandBlock: prompt extraction from terminal output
 * - isIdlePromptBlock: idle prompt detection
 * - scheduleBufferFallback: timer-based buffer polling and delivery
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureWindowText,
  extractLastCommandBlock,
  isIdlePromptBlock,
  scheduleBufferFallback,
  type BufferFallbackDeps,
} from '../../src/bridge/message-buffer-fallback.js';

// ── captureWindowText ────────────────────────────────────────────────

describe('captureWindowText', () => {
  it('returns frame lines when getWindowFrame is available', () => {
    const runtime = {
      getWindowFrame: vi.fn().mockReturnValue({
        lines: [
          { segments: [{ text: 'hello ' }, { text: 'world' }] },
          { segments: [{ text: 'line2' }] },
        ],
      }),
    } as any;

    const result = captureWindowText(runtime, 'sess', 'win');
    expect(result).toBe('hello world\nline2');
    expect(runtime.getWindowFrame).toHaveBeenCalledWith('sess', 'win');
  });

  it('trims trailing empty lines from frame output', () => {
    const runtime = {
      getWindowFrame: vi.fn().mockReturnValue({
        lines: [
          { segments: [{ text: 'content' }] },
          { segments: [{ text: '' }] },
          { segments: [{ text: '  ' }] },
        ],
      }),
    } as any;

    const result = captureWindowText(runtime, 'sess', 'win');
    expect(result).toBe('content');
  });

  it('falls back to getWindowBuffer when getWindowFrame returns null', () => {
    const runtime = {
      getWindowFrame: vi.fn().mockReturnValue(null),
      getWindowBuffer: vi.fn().mockReturnValue('buffer content'),
    } as any;

    const result = captureWindowText(runtime, 'sess', 'win');
    expect(result).not.toBeNull();
    expect(runtime.getWindowBuffer).toHaveBeenCalledWith('sess', 'win');
  });

  it('falls back to getWindowBuffer when getWindowFrame throws', () => {
    const runtime = {
      getWindowFrame: vi.fn().mockImplementation(() => { throw new Error('oops'); }),
      getWindowBuffer: vi.fn().mockReturnValue('fallback buffer'),
    } as any;

    const result = captureWindowText(runtime, 'sess', 'win');
    expect(result).not.toBeNull();
    expect(runtime.getWindowBuffer).toHaveBeenCalled();
  });

  it('returns null when getWindowBuffer returns null', () => {
    const runtime = {
      getWindowBuffer: vi.fn().mockReturnValue(null),
    } as any;

    const result = captureWindowText(runtime, 'sess', 'win');
    expect(result).toBeNull();
  });

  it('returns null when getWindowBuffer throws', () => {
    const runtime = {
      getWindowBuffer: vi.fn().mockImplementation(() => { throw new Error('fail'); }),
    } as any;

    const result = captureWindowText(runtime, 'sess', 'win');
    expect(result).toBeNull();
  });

  it('returns null when neither method is available', () => {
    const runtime = {} as any;
    const result = captureWindowText(runtime, 'sess', 'win');
    expect(result).toBeNull();
  });
});

// ── extractLastCommandBlock ──────────────────────────────────────────

describe('extractLastCommandBlock', () => {
  it('returns full text when no prompt marker found', () => {
    const text = 'some output\nmore output';
    expect(extractLastCommandBlock(text)).toBe(text);
  });

  it('extracts block from last prompt marker', () => {
    const text = '❯ first command\noutput1\n❯ second command\noutput2';
    expect(extractLastCommandBlock(text)).toBe('❯ second command\noutput2');
  });

  it('trims trailing empty lines from block', () => {
    const text = '❯ cmd\nresult\n\n  \n';
    expect(extractLastCommandBlock(text)).toBe('❯ cmd\nresult');
  });

  it('returns empty string for idle prompt block', () => {
    const text = '❯ /model\n───────────────────────────────\n Select model\n';
    const result = extractLastCommandBlock(text);
    expect(result).toBe('');
  });
});

// ── isIdlePromptBlock ────────────────────────────────────────────────

describe('isIdlePromptBlock', () => {
  it('returns true for empty block', () => {
    expect(isIdlePromptBlock([])).toBe(true);
  });

  it('returns true for prompt-only block', () => {
    expect(isIdlePromptBlock(['❯ /model'])).toBe(true);
  });

  it('returns true for prompt + separator + minimal content', () => {
    expect(isIdlePromptBlock([
      '❯ /model',
      '',
      '───────────────────────────────',
      ' Select model',
    ])).toBe(true);
  });

  it('returns false for block with substantive content', () => {
    expect(isIdlePromptBlock([
      '❯ run tests',
      '',
      '───────────────────────────────',
      'Line 1 of output',
      'Line 2 of output',
      'Line 3 of output',
    ])).toBe(false);
  });

  it('returns false when first content line is not a separator', () => {
    expect(isIdlePromptBlock([
      '❯ run tests',
      '',
      'This is real content',
      'More content',
    ])).toBe(false);
  });
});

// ── scheduleBufferFallback ───────────────────────────────────────────

describe('scheduleBufferFallback', () => {
  let deps: BufferFallbackDeps;
  let fallbackTimers: Map<string, ReturnType<typeof setTimeout>>;
  let messaging: any;
  let runtime: any;
  let pendingTracker: any;

  beforeEach(() => {
    vi.useFakeTimers();

    messaging = {
      sendToChannel: vi.fn().mockResolvedValue(undefined),
    };
    pendingTracker = {
      hasPending: vi.fn().mockReturnValue(true),
      isHookActive: vi.fn().mockReturnValue(false),
      markCompleted: vi.fn().mockResolvedValue(undefined),
    };
    runtime = {
      getWindowBuffer: vi.fn().mockReturnValue('some buffer content'),
    };

    deps = { messaging, runtime, pendingTracker };
    fallbackTimers = new Map();

    process.env.DISCODE_BUFFER_FALLBACK_INITIAL_MS = '3000';
    process.env.DISCODE_BUFFER_FALLBACK_STABLE_MS = '2000';
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const timer of fallbackTimers.values()) clearTimeout(timer);
    delete process.env.DISCODE_BUFFER_FALLBACK_INITIAL_MS;
    delete process.env.DISCODE_BUFFER_FALLBACK_STABLE_MS;
  });

  it('sends buffer content to channel after stable detection', async () => {
    scheduleBufferFallback(deps, fallbackTimers, 'sess', 'win', 'proj', 'claude', 'claude', 'ch-1');

    // Initial delay
    await vi.advanceTimersByTimeAsync(3000);
    // First check: buffer captured → snapshot stored, schedule recheck
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    // Stability check: buffer unchanged → send
    await vi.advanceTimersByTimeAsync(2000);
    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', expect.stringContaining('some buffer content'));
    expect(pendingTracker.markCompleted).toHaveBeenCalledWith('proj', 'claude', 'claude');
  });

  it('does not send when pending is already resolved', async () => {
    pendingTracker.hasPending.mockReturnValue(false);

    scheduleBufferFallback(deps, fallbackTimers, 'sess', 'win', 'proj', 'claude', 'claude', 'ch-1');

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('defers to hook handler when hook is active', async () => {
    pendingTracker.isHookActive.mockReturnValue(true);

    scheduleBufferFallback(deps, fallbackTimers, 'sess', 'win', 'proj', 'claude', 'claude', 'ch-1');

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('does not send when buffer is empty', async () => {
    runtime.getWindowBuffer.mockReturnValue(null);

    scheduleBufferFallback(deps, fallbackTimers, 'sess', 'win', 'proj', 'claude', 'claude', 'ch-1');

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('retries when buffer changes between checks', async () => {
    let callCount = 0;
    runtime.getWindowBuffer.mockImplementation(() => {
      callCount++;
      if (callCount <= 1) return 'changing...';
      return 'stable content';
    });

    scheduleBufferFallback(deps, fallbackTimers, 'sess', 'win', 'proj', 'claude', 'claude', 'ch-1');

    await vi.advanceTimersByTimeAsync(3000);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(messaging.sendToChannel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', expect.stringContaining('stable content'));
  });

  it('gives up after max checks when buffer keeps changing', async () => {
    let callCount = 0;
    runtime.getWindowBuffer.mockImplementation(() => {
      callCount++;
      return `frame-${callCount}`;
    });

    scheduleBufferFallback(deps, fallbackTimers, 'sess', 'win', 'proj', 'claude', 'claude', 'ch-1');

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('cancels previous timer when rescheduled', async () => {
    scheduleBufferFallback(deps, fallbackTimers, 'sess', 'win', 'proj', 'claude', 'claude', 'ch-1');
    expect(fallbackTimers.size).toBe(1);

    // Schedule again — should cancel previous
    runtime.getWindowBuffer.mockReturnValue('new content');
    scheduleBufferFallback(deps, fallbackTimers, 'sess', 'win', 'proj', 'claude', 'claude', 'ch-1');
    expect(fallbackTimers.size).toBe(1);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).toHaveBeenCalledTimes(1);
    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', expect.stringContaining('new content'));
  });

  it('handles send failure gracefully', async () => {
    messaging.sendToChannel.mockRejectedValueOnce(new Error('API error'));

    scheduleBufferFallback(deps, fallbackTimers, 'sess', 'win', 'proj', 'claude', 'claude', 'ch-1');

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).toHaveBeenCalled();
    // Should not throw — handled gracefully
  });

  it('skips idle prompt content', async () => {
    const idlePrompt = [
      '❯ /model',
      '───────────────────────────────',
      ' Select model',
    ].join('\n');
    runtime.getWindowBuffer.mockReturnValue(idlePrompt);

    scheduleBufferFallback(deps, fallbackTimers, 'sess', 'win', 'proj', 'claude', 'claude', 'ch-1');

    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });
});
