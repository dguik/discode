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
    });

    await handleTaskProgress(deps, ctx);

    expect(deps.messaging.sendToChannelWithId).toHaveBeenCalledWith(
      'ch-1', expect.stringContaining('Write tests'),
    );
    const msg = (deps.messaging.sendToChannelWithId as any).mock.calls[0][1];
    expect(msg).toContain('작업 목록 (0/1 완료)');
    expect(msg).toContain('⬜ #1 Write tests');
  });

  it('updates existing checklist message on second TASK_CREATE', async () => {
    const deps = createMockDeps();

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Task A"}',
    }));

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Task B"}',
    }));

    expect(deps.messaging.updateMessage).toHaveBeenCalledWith(
      'ch-1', 'msg-id', expect.stringContaining('Task B'),
    );
    const msg = (deps.messaging.updateMessage as any).mock.calls[0][2];
    expect(msg).toContain('0/2 완료');
    expect(msg).toContain('#1 Task A');
    expect(msg).toContain('#2 Task B');
  });

  it('updates task status on TASK_UPDATE', async () => {
    const deps = createMockDeps();

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Task A"}',
    }));

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_UPDATE:{"taskId":"1","status":"completed","subject":""}',
    }));

    const msg = (deps.messaging.updateMessage as any).mock.calls[0][2];
    expect(msg).toContain('1/1 완료');
    expect(msg).toContain('☑️ #1 Task A');
  });

  it('shows in_progress icon for in_progress status', async () => {
    const deps = createMockDeps();

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Working"}',
    }));

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_UPDATE:{"taskId":"1","status":"in_progress","subject":""}',
    }));

    const msg = (deps.messaging.updateMessage as any).mock.calls[0][2];
    expect(msg).toContain('🔄 #1 Working');
  });

  it('updates subject when provided in TASK_UPDATE', async () => {
    const deps = createMockDeps();

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Old name"}',
    }));

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_UPDATE:{"taskId":"1","status":"","subject":"New name"}',
    }));

    const msg = (deps.messaging.updateMessage as any).mock.calls[0][2];
    expect(msg).toContain('New name');
  });

  it('returns true without sending when text is undefined', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();

    const result = await handleTaskProgress(deps, ctx);
    expect(result).toBe(true);
    expect(deps.messaging.sendToChannelWithId).not.toHaveBeenCalled();
  });

  it('handles malformed JSON gracefully', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'TASK_CREATE:{not valid json',
    });

    const result = await handleTaskProgress(deps, ctx);
    expect(result).toBe(true);
  });

  it('accumulates tasks in same checklist across multiple creates', async () => {
    const deps = createMockDeps();

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Task A"}',
    }));

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Task B"}',
    }));

    // Second TASK_CREATE updates the same message
    expect(deps.messaging.sendToChannelWithId).toHaveBeenCalledTimes(1);
    expect(deps.messaging.updateMessage).toHaveBeenCalledTimes(1);
    const msg = (deps.messaging.updateMessage as any).mock.calls[0][2];
    expect(msg).toContain('0/2 완료');
    expect(msg).toContain('Task A');
    expect(msg).toContain('Task B');
  });

  it('ignores TASK_UPDATE for non-existent taskId', async () => {
    const deps = createMockDeps();

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Task A"}',
    }));

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_UPDATE:{"taskId":"99","status":"completed","subject":""}',
    }));

    const msg = (deps.messaging.updateMessage as any).mock.calls[0][2];
    expect(msg).toContain('0/1 완료');
  });

  it('appends to streaming updater', async () => {
    const deps = createMockDeps();
    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Test"}',
    }));

    expect(deps.streamingUpdater.append).toHaveBeenCalledWith(
      'proj', 'claude', expect.stringContaining('Test'),
    );
  });

  it('handles messaging failure gracefully', async () => {
    const deps = createMockDeps();
    (deps.messaging.sendToChannelWithId as any).mockRejectedValue(new Error('Slack error'));

    const result = await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Test"}',
    }));

    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleGitActivity
// ---------------------------------------------------------------------------

describe('handleGitActivity', () => {
  it('posts commit message to channel', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'GIT_COMMIT:{"hash":"abc1234","message":"fix bug","stat":"3 files changed"}',
    });

    await handleGitActivity(deps, ctx);

    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1', expect.stringContaining('fix bug'),
    );
    const msg = (deps.messaging.sendToChannel as any).mock.calls[0][1];
    expect(msg).toContain('📦 *Committed:*');
    expect(msg).toContain('3 files changed');
  });

  it('posts commit without stat when stat is empty', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'GIT_COMMIT:{"hash":"abc1234","message":"fix bug","stat":""}',
    });

    await handleGitActivity(deps, ctx);

    const msg = (deps.messaging.sendToChannel as any).mock.calls[0][1];
    expect(msg).toBe('📦 *Committed:* `fix bug`');
  });

  it('posts push message to channel', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'GIT_PUSH:{"toHash":"abcdef1234567","remoteRef":"main"}',
    });

    await handleGitActivity(deps, ctx);

    const msg = (deps.messaging.sendToChannel as any).mock.calls[0][1];
    expect(msg).toContain('🚀 *Pushed to*');
    expect(msg).toContain('`main`');
    expect(msg).toContain('abcdef1');
  });

  it('truncates push hash to 7 chars', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'GIT_PUSH:{"toHash":"abcdef1234567890","remoteRef":"main"}',
    });

    await handleGitActivity(deps, ctx);

    const msg = (deps.messaging.sendToChannel as any).mock.calls[0][1];
    expect(msg).toContain('(`abcdef1`)');
    expect(msg).not.toContain('abcdef12');
  });

  it('returns true without sending when text is undefined', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();

    const result = await handleGitActivity(deps, ctx);
    expect(result).toBe(true);
    expect(deps.messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('handles malformed JSON gracefully', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'GIT_COMMIT:not-json',
    });

    const result = await handleGitActivity(deps, ctx);
    expect(result).toBe(true);
    expect(deps.messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('appends to streaming updater', async () => {
    const deps = createMockDeps();
    await handleGitActivity(deps, createCtx({
      text: 'GIT_COMMIT:{"hash":"abc","message":"fix","stat":""}',
    }));

    expect(deps.streamingUpdater.append).toHaveBeenCalledWith(
      'proj', 'claude', expect.stringContaining('Committed'),
    );
  });

  it('uses "remote" when remoteRef is missing', async () => {
    const deps = createMockDeps();
    await handleGitActivity(deps, createCtx({
      text: 'GIT_PUSH:{"toHash":"abc1234"}',
    }));

    const msg = (deps.messaging.sendToChannel as any).mock.calls[0][1];
    expect(msg).toContain('*Pushed to*');
    expect(msg).toContain('`remote`');
  });

  it('handles messaging failure gracefully', async () => {
    const deps = createMockDeps();
    (deps.messaging.sendToChannel as any).mockRejectedValue(new Error('Slack error'));

    const result = await handleGitActivity(deps, createCtx({
      text: 'GIT_COMMIT:{"hash":"abc","message":"fix","stat":""}',
    }));

    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleSubagentDone
// ---------------------------------------------------------------------------

describe('handleSubagentDone', () => {
  it('posts subagent completion to channel', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'SUBAGENT_DONE:{"subagentType":"Explore","summary":"Found 14 modules"}',
    });

    await handleSubagentDone(deps, ctx);

    expect(deps.messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1', expect.stringContaining('Found 14 modules'),
    );
    const msg = (deps.messaging.sendToChannel as any).mock.calls[0][1];
    expect(msg).toContain('🔍 *Explore 완료:*');
  });

  it('uses "agent" as default subagent type', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'SUBAGENT_DONE:{"summary":"Done"}',
    });

    await handleSubagentDone(deps, ctx);

    const msg = (deps.messaging.sendToChannel as any).mock.calls[0][1];
    expect(msg).toContain('🔍 *agent 완료:*');
  });

  it('returns true without sending when summary is empty', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'SUBAGENT_DONE:{"subagentType":"Bash","summary":""}',
    });

    const result = await handleSubagentDone(deps, ctx);
    expect(result).toBe(true);
    expect(deps.messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('returns true without sending when text is undefined', async () => {
    const deps = createMockDeps();
    const ctx = createCtx();

    const result = await handleSubagentDone(deps, ctx);
    expect(result).toBe(true);
    expect(deps.messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('handles malformed JSON gracefully', async () => {
    const deps = createMockDeps();
    const ctx = createCtx({
      text: 'SUBAGENT_DONE:{bad json',
    });

    const result = await handleSubagentDone(deps, ctx);
    expect(result).toBe(true);
    expect(deps.messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('appends to streaming updater', async () => {
    const deps = createMockDeps();
    await handleSubagentDone(deps, createCtx({
      text: 'SUBAGENT_DONE:{"subagentType":"Plan","summary":"Plan ready"}',
    }));

    expect(deps.streamingUpdater.append).toHaveBeenCalledWith(
      'proj', 'claude', expect.stringContaining('Plan 완료'),
    );
  });

  it('handles messaging failure gracefully', async () => {
    const deps = createMockDeps();
    (deps.messaging.sendToChannel as any).mockRejectedValue(new Error('Slack error'));

    const result = await handleSubagentDone(deps, createCtx({
      text: 'SUBAGENT_DONE:{"subagentType":"Explore","summary":"Found stuff"}',
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

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Old task"}',
    }));

    clearTaskChecklist('proj:claude');

    await handleTaskProgress(deps, createCtx({
      text: 'TASK_CREATE:{"subject":"Fresh task"}',
    }));

    // Should create a new message (sendToChannelWithId called twice)
    expect(deps.messaging.sendToChannelWithId).toHaveBeenCalledTimes(2);
    const secondMsg = (deps.messaging.sendToChannelWithId as any).mock.calls[1][1];
    expect(secondMsg).toContain('0/1 완료');
    expect(secondMsg).toContain('Fresh task');
    expect(secondMsg).not.toContain('Old task');
  });
});
