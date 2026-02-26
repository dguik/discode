import { describe, expect, it, vi } from 'vitest';
import type { EventHandlerDeps } from '../../src/bridge/hook-event-handlers.js';
import type { EventContext } from '../../src/bridge/hook-event-pipeline.js';
import {
  handlePermissionRequest,
  handleTaskCompleted,
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

describe('handlePermissionRequest', () => {
  it('sends permission message with toolName and toolInput', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      event: { toolName: 'Bash', toolInput: 'npm test' },
    });

    await handlePermissionRequest(deps, ctx);

    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      '🔐 *Permission needed:* `Bash` — `npm test`',
    );
  });

  it('sends message without toolInput when empty', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      event: { toolName: 'Bash', toolInput: '' },
    });

    await handlePermissionRequest(deps, ctx);

    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      '🔐 *Permission needed:* `Bash`',
    );
  });

  it('sends message without toolInput when missing', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      event: { toolName: 'Bash' },
    });

    await handlePermissionRequest(deps, ctx);

    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      '🔐 *Permission needed:* `Bash`',
    );
  });

  it('uses "unknown" when toolName is missing', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ event: {} });

    await handlePermissionRequest(deps, ctx);

    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      '🔐 *Permission needed:* `unknown`',
    );
  });
});

describe('handleTaskCompleted', () => {
  it('sends task completed message with subject', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      event: { taskId: 'task-1', taskSubject: 'Fix login bug' },
    });

    await handleTaskCompleted(deps, ctx);

    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      '✅ *Task completed*: Fix login bug',
    );
  });

  it('includes teammate prefix when provided', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      event: { taskId: 'task-1', taskSubject: 'Write tests', teammateName: 'agent-2' },
    });

    await handleTaskCompleted(deps, ctx);

    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      '✅ *[agent-2] Task completed*: Write tests',
    );
  });

  it('sends message without subject when missing', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      event: { taskId: 'task-1' },
    });

    await handleTaskCompleted(deps, ctx);

    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      '✅ *Task completed*',
    );
  });

  it('handles missing taskId gracefully', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      event: { taskSubject: 'Done' },
    });

    await handleTaskCompleted(deps, ctx);

    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      '✅ *Task completed*: Done',
    );
  });
});
