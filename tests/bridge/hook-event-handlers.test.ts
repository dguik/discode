import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventHandlerDeps } from '../../src/bridge/hook-event-handlers.js';
import type { EventContext } from '../../src/bridge/hook-event-pipeline.js';
import {
  handleSessionError,
  handleSessionStart,
  handleSessionEnd,
  handleSessionNotification,
  handleThinkingStart,
  handleThinkingStop,
  handleToolActivity,
  handleSessionIdle,
} from '../../src/bridge/hook-event-handlers.js';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  realpathSync: vi.fn((p: string) => p),
}));

vi.mock('../../src/capture/parser.js', () => ({
  splitForDiscord: vi.fn((text: string) => [text]),
  splitForSlack: vi.fn((text: string) => [text]),
  extractFilePaths: vi.fn(() => []),
  stripFilePaths: vi.fn((text: string) => text),
}));

function createMockDeps(): EventHandlerDeps {
  return {
    messaging: {
      platform: 'discord' as const,
      sendToChannel: vi.fn().mockResolvedValue(undefined),
      sendToChannelWithId: vi.fn().mockResolvedValue('msg-id'),
      sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
      addReactionToMessage: vi.fn().mockResolvedValue(undefined),
      replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
      replyInThread: vi.fn().mockResolvedValue(undefined),
      replyInThreadWithId: vi.fn().mockResolvedValue('reply-id'),
      updateMessage: vi.fn().mockResolvedValue(undefined),
    } as any,
    pendingTracker: {
      hasPending: vi.fn().mockReturnValue(false),
      getPending: vi.fn().mockReturnValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      setHookActive: vi.fn(),
      ensureStartMessage: vi.fn().mockResolvedValue(undefined),
    } as any,
    streamingUpdater: {
      has: vi.fn().mockReturnValue(false),
      start: vi.fn(),
      append: vi.fn(),
      discard: vi.fn(),
      finalize: vi.fn().mockResolvedValue(undefined),
    } as any,
    thinkingTimers: new Map(),
    threadActivityMessages: new Map(),
    sessionLifecycleTimers: new Map(),
    ensureStartMessageAndStreaming: vi.fn().mockResolvedValue(undefined),
    clearThinkingTimer: vi.fn(),
    clearSessionLifecycleTimer: vi.fn(),
  };
}

function createCtx(overrides: Partial<EventContext> = {}): EventContext {
  return {
    event: {},
    projectName: 'myProject',
    channelId: 'ch-1',
    agentType: 'opencode',
    instanceId: undefined,
    instanceKey: 'opencode',
    text: undefined,
    projectPath: '/tmp/project',
    pendingSnapshot: undefined,
    ...overrides,
  };
}

describe('handleSessionError', () => {
  it('sends error message to channel', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ text: 'crash happened' });
    const result = await handleSessionError(deps, ctx);
    expect(result).toBe(true);
    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith('ch-1', expect.stringContaining('crash happened'));
  });

  it('uses "unknown error" when text is empty', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ text: undefined });
    await handleSessionError(deps, ctx);
    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith('ch-1', expect.stringContaining('unknown error'));
  });

  it('clears thinking timer and streaming updater', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();
    await handleSessionError(deps, ctx);
    expect(deps.clearThinkingTimer).toHaveBeenCalledWith('myProject:opencode');
    expect(deps.streamingUpdater.discard).toHaveBeenCalledWith('myProject', 'opencode');
  });

  it('marks pending as error', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();
    await handleSessionError(deps, ctx);
    expect(deps.pendingTracker.markError).toHaveBeenCalledWith('myProject', 'opencode', undefined);
  });

  it('clears thread activity messages', async () => {
    const deps = createMockDeps();
    deps.threadActivityMessages.set('myProject:opencode', {
      channelId: 'ch-1', parentMessageId: 'p1', messageId: 'm1', lines: ['test'],
    });
    const ctx = createCtx();
    await handleSessionError(deps, ctx);
    expect(deps.threadActivityMessages.has('myProject:opencode')).toBe(false);
  });
});

describe('handleSessionNotification', () => {
  it('sends notification with appropriate emoji', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      event: { notificationType: 'permission_prompt' },
      text: 'Needs permission',
    });
    await handleSessionNotification(deps, ctx);
    const msg = (deps.messaging.sendToChannel as any).mock.calls[0][1];
    expect(msg).toContain('Needs permission');
  });

  it('sends promptText if present', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      event: { notificationType: 'idle_prompt', promptText: 'Choose an option' },
      text: 'idle',
    });
    await handleSessionNotification(deps, ctx);
    expect(deps.messaging.sendToChannel).toHaveBeenCalledTimes(2);
  });

  it('uses default bell emoji for unknown notification type', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      event: { notificationType: 'some_new_type' },
      text: 'msg',
    });
    await handleSessionNotification(deps, ctx);
    const msg = (deps.messaging.sendToChannel as any).mock.calls[0][1];
    expect(msg).toContain('msg');
  });
});

describe('handleSessionStart', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips sending message for startup source', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ event: { source: 'startup' } });
    const result = await handleSessionStart(deps, ctx);
    expect(result).toBe(true);
    expect(deps.messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('sends session started message with source', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ event: { source: 'user', model: 'claude-4' } });
    await handleSessionStart(deps, ctx);
    const msg = (deps.messaging.sendToChannel as any).mock.calls[0][1];
    expect(msg).toContain('Session started');
    expect(msg).toContain('user');
    expect(msg).toContain('claude-4');
  });

  it('sets hook active on pending tracker', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ event: { source: 'user' } });
    await handleSessionStart(deps, ctx);
    expect(deps.pendingTracker.setHookActive).toHaveBeenCalledWith('myProject', 'opencode', undefined);
  });

  it('clears previous session lifecycle timer', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ event: { source: 'user' } });
    await handleSessionStart(deps, ctx);
    expect(deps.clearSessionLifecycleTimer).toHaveBeenCalledWith('myProject:opencode');
  });
});

describe('handleSessionEnd', () => {
  it('sends session ended message with reason', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ event: { reason: 'user_stop' } });
    await handleSessionEnd(deps, ctx);
    const msg = (deps.messaging.sendToChannel as any).mock.calls[0][1];
    expect(msg).toContain('Session ended');
    expect(msg).toContain('user_stop');
  });

  it('sets hook active', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ event: { reason: 'done' } });
    await handleSessionEnd(deps, ctx);
    expect(deps.pendingTracker.setHookActive).toHaveBeenCalled();
  });
});

describe('handleThinkingStart', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls ensureStartMessageAndStreaming', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();
    await handleThinkingStart(deps, ctx);
    expect(deps.ensureStartMessageAndStreaming).toHaveBeenCalledWith(ctx);
  });

  it('clears session lifecycle timer', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();
    await handleThinkingStart(deps, ctx);
    expect(deps.clearSessionLifecycleTimer).toHaveBeenCalledWith('myProject:opencode');
  });

  it('adds brain reaction when pending has messageId', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      pendingSnapshot: { channelId: 'ch-1', messageId: 'msg-1' },
    });
    await handleThinkingStart(deps, ctx);
    expect(deps.messaging.addReactionToMessage).toHaveBeenCalledWith('ch-1', 'msg-1', expect.any(String));
  });

  it('appends thinking text to streaming updater', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();
    await handleThinkingStart(deps, ctx);
    expect(deps.streamingUpdater.append).toHaveBeenCalledWith('myProject', 'opencode', expect.stringContaining('Thinking'));
  });

  it('clears previous thinking timer before starting new', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();
    await handleThinkingStart(deps, ctx);
    expect(deps.clearThinkingTimer).toHaveBeenCalledWith('myProject:opencode');
  });
});

describe('handleThinkingStop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears thinking timer', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();
    await handleThinkingStop(deps, ctx);
    expect(deps.clearThinkingTimer).toHaveBeenCalledWith('myProject:opencode');
  });

  it('appends elapsed time when >= 5 seconds', async () => {
    const deps = createMockDeps();
    deps.thinkingTimers.set('myProject:opencode', {
      timer: setInterval(() => {}, 999999),
      startTime: Date.now() - 6000,
    });
    const ctx = createCtx();
    await handleThinkingStop(deps, ctx);
    expect(deps.streamingUpdater.append).toHaveBeenCalledWith('myProject', 'opencode', expect.stringContaining('Thought for'));
  });

  it('does not append elapsed time when < 5 seconds', async () => {
    const deps = createMockDeps();
    deps.thinkingTimers.set('myProject:opencode', {
      timer: setInterval(() => {}, 999999),
      startTime: Date.now() - 2000,
    });
    const ctx = createCtx();
    await handleThinkingStop(deps, ctx);
    expect(deps.streamingUpdater.append).not.toHaveBeenCalled();
  });

  it('replaces brain reaction with checkmark when pending has messageId', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      pendingSnapshot: { channelId: 'ch-1', messageId: 'msg-1' },
    });
    await handleThinkingStop(deps, ctx);
    expect(deps.messaging.replaceOwnReactionOnMessage).toHaveBeenCalled();
  });
});

describe('handleToolActivity', () => {
  it('calls ensureStartMessageAndStreaming', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ text: 'Reading file...' });
    await handleToolActivity(deps, ctx);
    expect(deps.ensureStartMessageAndStreaming).toHaveBeenCalledWith(ctx);
  });

  it('clears session lifecycle timer', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ text: 'Reading...' });
    await handleToolActivity(deps, ctx);
    expect(deps.clearSessionLifecycleTimer).toHaveBeenCalledWith('myProject:opencode');
  });

  it('appends text to streaming updater', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ text: 'Writing file...' });
    await handleToolActivity(deps, ctx);
    expect(deps.streamingUpdater.append).toHaveBeenCalledWith('myProject', 'opencode', 'Writing file...');
  });

  it('creates thread reply when no existing activity message', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'Activity text',
      pendingSnapshot: { channelId: 'ch-1', messageId: 'msg-1', startMessageId: 'start-1' },
    });
    await handleToolActivity(deps, ctx);
    expect(deps.messaging.replyInThreadWithId).toHaveBeenCalledWith('ch-1', 'start-1', 'Activity text');
  });

  it('updates existing thread activity message for same parent', async () => {
    const deps = createMockDeps();
    deps.threadActivityMessages.set('myProject:opencode', {
      channelId: 'ch-1', parentMessageId: 'start-1', messageId: 'activity-1', lines: ['line1'],
    });
    const ctx = createCtx({
      text: 'line2',
      pendingSnapshot: { channelId: 'ch-1', messageId: 'msg-1', startMessageId: 'start-1' },
    });
    await handleToolActivity(deps, ctx);
    expect(deps.messaging.updateMessage).toHaveBeenCalledWith('ch-1', 'activity-1', 'line1\nline2');
  });

  it('creates new thread activity message when parent differs', async () => {
    const deps = createMockDeps();
    deps.threadActivityMessages.set('myProject:opencode', {
      channelId: 'ch-1', parentMessageId: 'old-start', messageId: 'activity-1', lines: ['old'],
    });
    const ctx = createCtx({
      text: 'new activity',
      pendingSnapshot: { channelId: 'ch-1', messageId: 'msg-1', startMessageId: 'new-start' },
    });
    await handleToolActivity(deps, ctx);
    expect(deps.messaging.replyInThreadWithId).toHaveBeenCalledWith('ch-1', 'new-start', 'new activity');
  });

  it('does not post thread reply when no text', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: undefined,
      pendingSnapshot: { channelId: 'ch-1', messageId: 'msg-1', startMessageId: 'start-1' },
    });
    await handleToolActivity(deps, ctx);
    expect(deps.messaging.replyInThreadWithId).not.toHaveBeenCalled();
  });
});

describe('handleSessionIdle', () => {
  it('clears thinking timer and session lifecycle timer', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();
    await handleSessionIdle(deps, ctx);
    expect(deps.clearThinkingTimer).toHaveBeenCalledWith('myProject:opencode');
    expect(deps.clearSessionLifecycleTimer).toHaveBeenCalledWith('myProject:opencode');
  });

  it('clears thread activity messages', async () => {
    const deps = createMockDeps();
    deps.threadActivityMessages.set('myProject:opencode', {
      channelId: 'ch-1', parentMessageId: 'p1', messageId: 'm1', lines: ['test'],
    });
    const ctx = createCtx();
    await handleSessionIdle(deps, ctx);
    expect(deps.threadActivityMessages.has('myProject:opencode')).toBe(false);
  });

  it('finalizes streaming when startMessageId exists', async () => {
    const deps = createMockDeps();
    (deps.pendingTracker.getPending as any).mockReturnValue({
      channelId: 'ch-1', messageId: 'msg-1', startMessageId: 'start-1',
    });
    const ctx = createCtx();
    await handleSessionIdle(deps, ctx);
    expect(deps.streamingUpdater.finalize).toHaveBeenCalled();
  });

  it('marks pending as completed', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();
    await handleSessionIdle(deps, ctx);
    expect(deps.pendingTracker.markCompleted).toHaveBeenCalledWith('myProject', 'opencode', undefined);
  });

  it('sends response text to channel', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ text: 'Here is the answer' });
    await handleSessionIdle(deps, ctx);
    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith('ch-1', 'Here is the answer');
  });

  it('does not send when text is empty', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ text: undefined });
    await handleSessionIdle(deps, ctx);
    expect(deps.messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('sends promptText to channel', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      event: { promptText: 'Do you approve?' },
      text: 'Response',
    });
    await handleSessionIdle(deps, ctx);
    const calls = (deps.messaging.sendToChannel as any).mock.calls;
    const texts = calls.map((c: any) => c[1]);
    expect(texts).toContain('Do you approve?');
  });
});
