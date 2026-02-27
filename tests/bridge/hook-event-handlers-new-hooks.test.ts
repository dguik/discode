import { describe, expect, it, vi } from 'vitest';
import type { EventHandlerDeps } from '../../src/bridge/hook-event-handlers.js';
import type { EventContext } from '../../src/bridge/hook-event-pipeline.js';
import {
  handlePromptSubmit,
  handleToolFailure,
  handleTeammateIdle,
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
      appendCumulative: vi.fn(),
      discard: vi.fn(),
      finalize: vi.fn().mockResolvedValue(undefined),
    } as any,
    thinkingTimers: new Map(),
    activityHistory: new Map(),
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

describe('handlePromptSubmit', () => {
  it('sends prompt message with text preview', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ text: 'Fix the login bug' });

    await handlePromptSubmit(deps, ctx);

    expect(deps.pendingTracker.ensureStartMessage).toHaveBeenCalledWith(
      'myProject',
      'opencode',
      undefined,
      'Fix the login bug',
    );
    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      '📝 Prompt: Fix the login bug',
    );
  });

  it('does not send fallback message when start message is created', async () => {
    const deps = createMockDeps();
    (deps.pendingTracker.ensureStartMessage as any).mockResolvedValue('start-msg-id');
    const ctx = createCtx({ text: 'Plan this change' });

    await handlePromptSubmit(deps, ctx);

    expect(deps.pendingTracker.ensureStartMessage).toHaveBeenCalled();
    expect(deps.messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('does nothing when text is empty', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ text: '' });

    await handlePromptSubmit(deps, ctx);

    expect(deps.messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('does nothing when text is undefined', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ text: undefined });

    await handlePromptSubmit(deps, ctx);

    expect(deps.messaging.sendToChannel).not.toHaveBeenCalled();
  });
});

describe('handleToolFailure', () => {
  it('sends failure message with toolName and error', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      event: { toolName: 'Bash', error: 'Command failed with exit code 1' },
    });

    await handleToolFailure(deps, ctx);

    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      '⚠️ *Bash failed*: Command failed with exit code 1',
    );
  });

  it('sends failure without error when error is missing', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      event: { toolName: 'Edit' },
    });

    await handleToolFailure(deps, ctx);

    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      '⚠️ *Edit failed*',
    );
  });

  it('uses "unknown" when toolName is missing', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ event: {} });

    await handleToolFailure(deps, ctx);

    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      '⚠️ *unknown failed*',
    );
  });

  it('sends error message with empty error string', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      event: { toolName: 'Bash', error: '' },
    });

    await handleToolFailure(deps, ctx);

    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      '⚠️ *Bash failed*',
    );
  });
});

describe('handleTeammateIdle', () => {
  it('sends idle message with teammate name', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      event: { teammateName: 'agent-2' },
    });

    await handleTeammateIdle(deps, ctx);

    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      '💤 *[agent-2]* idle',
    );
  });

  it('includes team name when provided', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      event: { teammateName: 'agent-3', teamName: 'backend-team' },
    });

    await handleTeammateIdle(deps, ctx);

    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      '💤 *[agent-3]* idle (backend-team)',
    );
  });

  it('does nothing when teammateName is missing', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ event: {} });

    await handleTeammateIdle(deps, ctx);

    expect(deps.messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('does nothing when teammateName is empty', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ event: { teammateName: '' } });

    await handleTeammateIdle(deps, ctx);

    expect(deps.messaging.sendToChannel).not.toHaveBeenCalled();
  });
});
