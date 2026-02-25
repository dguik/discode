import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventHandlerDeps } from '../../src/bridge/hook-event-handlers.js';
import type { EventContext } from '../../src/bridge/hook-event-pipeline.js';
import {
  handleTaskProgress,
  handleGitActivity,
  handleSubagentDone,
  clearTaskChecklist,
} from '../../src/bridge/hook-structured-handlers.js';

function createMockDeps(): EventHandlerDeps {
  return {
    messaging: {
      platform: 'slack' as const,
      sendToChannel: vi.fn().mockResolvedValue(undefined),
      sendToChannelWithId: vi.fn().mockResolvedValue('msg-id'),
      sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
      addReactionToMessage: vi.fn().mockResolvedValue(undefined),
      replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
      replyInThread: vi.fn().mockResolvedValue(undefined),
      replyInThreadWithId: vi.fn().mockResolvedValue('checklist-msg-id'),
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
    projectName: 'proj',
    channelId: 'ch-1',
    agentType: 'claude',
    instanceId: undefined,
    instanceKey: 'claude',
    text: undefined,
    projectPath: '/tmp/project',
    pendingSnapshot: undefined,
    ...overrides,
  };
}

function pendingWith(startMessageId: string) {
  return { channelId: 'ch-1', messageId: 'user-msg', startMessageId };
}

afterEach(() => {
  clearTaskChecklist('proj:claude');
});

// ---------------------------------------------------------------------------
// handleTaskProgress
// ---------------------------------------------------------------------------

describe('handleTaskProgress', () => {
  it('creates checklist message on first TASK_CREATE', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'TASK_CREATE:{"subject":"Write tests"}',
      pendingSnapshot: pendingWith('start-1'),
    });

    await handleTaskProgress(deps, ctx);

    expect(deps.messaging.replyInThreadWithId).toHaveBeenCalledWith(
      'ch-1', 'start-1', expect.stringContaining('Write tests'),
    );
    const msg = (deps.messaging.replyInThreadWithId as any).mock.calls[0][2];
    expect(msg).toContain('작업 목록 (0/1 완료)');
    expect(msg).toContain('⬜ #1 Write tests');
  });

  it('updates existing checklist message on second TASK_CREATE', async () => {
    const deps = createMockDeps();
    const pending = pendingWith('start-1');

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Task A"}',
      pendingSnapshot: pending,
    }));

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Task B"}',
      pendingSnapshot: pending,
    }));

    expect(deps.messaging.updateMessage).toHaveBeenCalledWith(
      'ch-1', 'checklist-msg-id', expect.stringContaining('Task B'),
    );
    const msg = (deps.messaging.updateMessage as any).mock.calls[0][2];
    expect(msg).toContain('0/2 완료');
    expect(msg).toContain('#1 Task A');
    expect(msg).toContain('#2 Task B');
  });

  it('updates task status on TASK_UPDATE', async () => {
    const deps = createMockDeps();
    const pending = pendingWith('start-1');

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Task A"}',
      pendingSnapshot: pending,
    }));

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_UPDATE:{"taskId":"1","status":"completed","subject":""}',
      pendingSnapshot: pending,
    }));

    const msg = (deps.messaging.updateMessage as any).mock.calls[0][2];
    expect(msg).toContain('1/1 완료');
    expect(msg).toContain('☑️ #1 Task A');
  });

  it('shows in_progress icon for in_progress status', async () => {
    const deps = createMockDeps();
    const pending = pendingWith('start-1');

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Working"}',
      pendingSnapshot: pending,
    }));

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_UPDATE:{"taskId":"1","status":"in_progress","subject":""}',
      pendingSnapshot: pending,
    }));

    const msg = (deps.messaging.updateMessage as any).mock.calls[0][2];
    expect(msg).toContain('🔄 #1 Working');
  });

  it('updates subject when provided in TASK_UPDATE', async () => {
    const deps = createMockDeps();
    const pending = pendingWith('start-1');

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Old name"}',
      pendingSnapshot: pending,
    }));

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_UPDATE:{"taskId":"1","status":"","subject":"New name"}',
      pendingSnapshot: pending,
    }));

    const msg = (deps.messaging.updateMessage as any).mock.calls[0][2];
    expect(msg).toContain('New name');
  });

  it('returns true without sending when no pending startMessageId', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ text: 'TASK_CREATE:{"subject":"Test"}' });

    const result = await handleTaskProgress(deps, ctx);
    expect(result).toBe(true);
    expect(deps.messaging.replyInThreadWithId).not.toHaveBeenCalled();
  });

  it('returns true without sending when text is undefined', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ pendingSnapshot: pendingWith('start-1') });

    const result = await handleTaskProgress(deps, ctx);
    expect(result).toBe(true);
    expect(deps.messaging.replyInThreadWithId).not.toHaveBeenCalled();
  });

  it('handles malformed JSON gracefully', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'TASK_CREATE:{not valid json',
      pendingSnapshot: pendingWith('start-1'),
    });

    const result = await handleTaskProgress(deps, ctx);
    expect(result).toBe(true);
  });

  it('resets checklist when parentMessageId changes', async () => {
    const deps = createMockDeps();

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Old task"}',
      pendingSnapshot: pendingWith('start-1'),
    }));

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"New task"}',
      pendingSnapshot: pendingWith('start-2'),
    }));

    // Should create a new message, not update the old one
    expect(deps.messaging.replyInThreadWithId).toHaveBeenCalledTimes(2);
    const secondMsg = (deps.messaging.replyInThreadWithId as any).mock.calls[1][2];
    expect(secondMsg).toContain('0/1 완료');
    expect(secondMsg).toContain('New task');
    expect(secondMsg).not.toContain('Old task');
  });

  it('ignores TASK_UPDATE for non-existent taskId', async () => {
    const deps = createMockDeps();
    const pending = pendingWith('start-1');

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Task A"}',
      pendingSnapshot: pending,
    }));

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_UPDATE:{"taskId":"99","status":"completed","subject":""}',
      pendingSnapshot: pending,
    }));

    const msg = (deps.messaging.updateMessage as any).mock.calls[0][2];
    expect(msg).toContain('0/1 완료');
  });

  it('appends to streaming updater', async () => {
    const deps = createMockDeps();
    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Test"}',
      pendingSnapshot: pendingWith('start-1'),
    }));

    expect(deps.streamingUpdater.append).toHaveBeenCalledWith(
      'proj', 'claude', expect.stringContaining('Test'),
    );
  });

  it('handles messaging failure gracefully', async () => {
    const deps = createMockDeps();
    (deps.messaging.replyInThreadWithId as any).mockRejectedValue(new Error('Slack error'));

    const result = await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Test"}',
      pendingSnapshot: pendingWith('start-1'),
    }));

    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleGitActivity
// ---------------------------------------------------------------------------

describe('handleGitActivity', () => {
  it('posts commit message as thread reply', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'GIT_COMMIT:{"hash":"abc1234","message":"fix bug","stat":"3 files changed"}',
      pendingSnapshot: pendingWith('start-1'),
    });

    await handleGitActivity(deps, ctx);

    expect(deps.messaging.replyInThread).toHaveBeenCalledWith(
      'ch-1', 'start-1', expect.stringContaining('fix bug'),
    );
    const msg = (deps.messaging.replyInThread as any).mock.calls[0][2];
    expect(msg).toContain('📦 Committed:');
    expect(msg).toContain('3 files changed');
  });

  it('posts commit without stat when stat is empty', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'GIT_COMMIT:{"hash":"abc1234","message":"fix bug","stat":""}',
      pendingSnapshot: pendingWith('start-1'),
    });

    await handleGitActivity(deps, ctx);

    const msg = (deps.messaging.replyInThread as any).mock.calls[0][2];
    expect(msg).toBe('📦 Committed: "fix bug"');
  });

  it('posts push message as thread reply', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'GIT_PUSH:{"toHash":"abcdef1234567","remoteRef":"main"}',
      pendingSnapshot: pendingWith('start-1'),
    });

    await handleGitActivity(deps, ctx);

    const msg = (deps.messaging.replyInThread as any).mock.calls[0][2];
    expect(msg).toContain('🚀 Pushed to main');
    expect(msg).toContain('abcdef1');
  });

  it('truncates push hash to 7 chars', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'GIT_PUSH:{"toHash":"abcdef1234567890","remoteRef":"main"}',
      pendingSnapshot: pendingWith('start-1'),
    });

    await handleGitActivity(deps, ctx);

    const msg = (deps.messaging.replyInThread as any).mock.calls[0][2];
    expect(msg).toContain('(abcdef1)');
    expect(msg).not.toContain('abcdef12');
  });

  it('returns true without sending when no pending startMessageId', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({ text: 'GIT_COMMIT:{"hash":"abc","message":"fix"}' });

    const result = await handleGitActivity(deps, ctx);
    expect(result).toBe(true);
    expect(deps.messaging.replyInThread).not.toHaveBeenCalled();
  });

  it('handles malformed JSON gracefully', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'GIT_COMMIT:not-json',
      pendingSnapshot: pendingWith('start-1'),
    });

    const result = await handleGitActivity(deps, ctx);
    expect(result).toBe(true);
    expect(deps.messaging.replyInThread).not.toHaveBeenCalled();
  });

  it('appends to streaming updater', async () => {
    const deps = createMockDeps();
    await handleGitActivity(deps, createCtx({
      text: 'GIT_COMMIT:{"hash":"abc","message":"fix","stat":""}',
      pendingSnapshot: pendingWith('start-1'),
    }));

    expect(deps.streamingUpdater.append).toHaveBeenCalledWith(
      'proj', 'claude', expect.stringContaining('Committed'),
    );
  });

  it('uses "remote" when remoteRef is missing', async () => {
    const deps = createMockDeps();
    await handleGitActivity(deps, createCtx({
      text: 'GIT_PUSH:{"toHash":"abc1234"}',
      pendingSnapshot: pendingWith('start-1'),
    }));

    const msg = (deps.messaging.replyInThread as any).mock.calls[0][2];
    expect(msg).toContain('Pushed to remote');
  });

  it('handles messaging failure gracefully', async () => {
    const deps = createMockDeps();
    (deps.messaging.replyInThread as any).mockRejectedValue(new Error('Slack error'));

    const result = await handleGitActivity(deps, createCtx({
      text: 'GIT_COMMIT:{"hash":"abc","message":"fix","stat":""}',
      pendingSnapshot: pendingWith('start-1'),
    }));

    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleSubagentDone
// ---------------------------------------------------------------------------

describe('handleSubagentDone', () => {
  it('posts subagent completion as thread reply', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'SUBAGENT_DONE:{"subagentType":"Explore","summary":"Found 14 modules"}',
      pendingSnapshot: pendingWith('start-1'),
    });

    await handleSubagentDone(deps, ctx);

    expect(deps.messaging.replyInThread).toHaveBeenCalledWith(
      'ch-1', 'start-1', expect.stringContaining('Found 14 modules'),
    );
    const msg = (deps.messaging.replyInThread as any).mock.calls[0][2];
    expect(msg).toContain('🔍 Explore 완료:');
  });

  it('uses "agent" as default subagent type', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'SUBAGENT_DONE:{"summary":"Done"}',
      pendingSnapshot: pendingWith('start-1'),
    });

    await handleSubagentDone(deps, ctx);

    const msg = (deps.messaging.replyInThread as any).mock.calls[0][2];
    expect(msg).toContain('🔍 agent 완료:');
  });

  it('returns true without sending when summary is empty', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'SUBAGENT_DONE:{"subagentType":"Bash","summary":""}',
      pendingSnapshot: pendingWith('start-1'),
    });

    const result = await handleSubagentDone(deps, ctx);
    expect(result).toBe(true);
    expect(deps.messaging.replyInThread).not.toHaveBeenCalled();
  });

  it('returns true without sending when no pending startMessageId', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'SUBAGENT_DONE:{"subagentType":"Explore","summary":"Found stuff"}',
    });

    const result = await handleSubagentDone(deps, ctx);
    expect(result).toBe(true);
    expect(deps.messaging.replyInThread).not.toHaveBeenCalled();
  });

  it('handles malformed JSON gracefully', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'SUBAGENT_DONE:{bad json',
      pendingSnapshot: pendingWith('start-1'),
    });

    const result = await handleSubagentDone(deps, ctx);
    expect(result).toBe(true);
    expect(deps.messaging.replyInThread).not.toHaveBeenCalled();
  });

  it('appends to streaming updater', async () => {
    const deps = createMockDeps();
    await handleSubagentDone(deps, createCtx({
      text: 'SUBAGENT_DONE:{"subagentType":"Plan","summary":"Plan ready"}',
      pendingSnapshot: pendingWith('start-1'),
    }));

    expect(deps.streamingUpdater.append).toHaveBeenCalledWith(
      'proj', 'claude', expect.stringContaining('Plan 완료'),
    );
  });

  it('handles messaging failure gracefully', async () => {
    const deps = createMockDeps();
    (deps.messaging.replyInThread as any).mockRejectedValue(new Error('Slack error'));

    const result = await handleSubagentDone(deps, createCtx({
      text: 'SUBAGENT_DONE:{"subagentType":"Explore","summary":"Found stuff"}',
      pendingSnapshot: pendingWith('start-1'),
    }));

    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// clearTaskChecklist
// ---------------------------------------------------------------------------

describe('clearTaskChecklist', () => {
  it('clears checklist state so next TASK_CREATE starts fresh', async () => {
    const deps = createMockDeps();
    const pending = pendingWith('start-1');

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Old task"}',
      pendingSnapshot: pending,
    }));

    clearTaskChecklist('proj:claude');

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Fresh task"}',
      pendingSnapshot: pending,
    }));

    // Should create a new message (replyInThreadWithId called twice)
    expect(deps.messaging.replyInThreadWithId).toHaveBeenCalledTimes(2);
    const secondMsg = (deps.messaging.replyInThreadWithId as any).mock.calls[1][2];
    expect(secondMsg).toContain('0/1 완료');
    expect(secondMsg).toContain('Fresh task');
    expect(secondMsg).not.toContain('Old task');
  });
});
