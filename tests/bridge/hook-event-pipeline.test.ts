import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookEventPipeline, type EventPipelineDeps } from '../../src/bridge/hook-event-pipeline.js';

vi.mock('../../src/state/instances.js', () => ({
  normalizeProjectState: vi.fn((project: any) => project),
  getProjectInstance: vi.fn((_project: any, instanceId: string) => {
    if (instanceId === 'inst-1') {
      return { instanceId: 'inst-1', agentType: 'opencode', channelId: 'ch-1' };
    }
    return undefined;
  }),
  getPrimaryInstanceForAgent: vi.fn((_project: any, agentType: string) => {
    if (agentType === 'opencode') {
      return { instanceId: 'primary', agentType: 'opencode', channelId: 'ch-1' };
    }
    return undefined;
  }),
}));

function createMockDeps(): EventPipelineDeps {
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
    stateManager: {
      getProject: vi.fn((name: string) => {
        if (name === 'myProject') {
          return { projectPath: '/tmp/project', instances: {} };
        }
        return undefined;
      }),
    } as any,
    pendingTracker: {
      hasPending: vi.fn().mockReturnValue(false),
      ensurePending: vi.fn().mockResolvedValue(undefined),
      getPending: vi.fn().mockReturnValue(undefined),
      ensureStartMessage: vi.fn().mockResolvedValue(undefined),
      markError: vi.fn().mockResolvedValue(undefined),
      markCompleted: vi.fn().mockResolvedValue(undefined),
      setHookActive: vi.fn(),
    } as any,
    streamingUpdater: {
      has: vi.fn().mockReturnValue(false),
      start: vi.fn(),
      append: vi.fn(),
      appendCumulative: vi.fn(),
      discard: vi.fn(),
      finalize: vi.fn().mockResolvedValue(undefined),
    } as any,
  };
}

describe('HookEventPipeline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('handleOpencodeEvent', () => {
    it('returns false and warns for null payload', async () => {
      const deps = createMockDeps();
      const pipeline = new HookEventPipeline(deps);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await pipeline.handleOpencodeEvent(null)).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid payload'));
      warnSpy.mockRestore();
    });

    it('returns false and warns for non-object payload', async () => {
      const deps = createMockDeps();
      const pipeline = new HookEventPipeline(deps);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await pipeline.handleOpencodeEvent('string')).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid payload'));
      warnSpy.mockRestore();
    });

    it('returns false and warns for invalid envelope field types', async () => {
      const deps = createMockDeps();
      const pipeline = new HookEventPipeline(deps);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await pipeline.handleOpencodeEvent({
        projectName: 'myProject',
        type: 'session.start',
        text: 123,
      })).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid payload'));
      warnSpy.mockRestore();
    });

    it('returns false and warns when projectName is missing', async () => {
      const deps = createMockDeps();
      const pipeline = new HookEventPipeline(deps);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await pipeline.handleOpencodeEvent({ type: 'session.start' })).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing projectName'));
      warnSpy.mockRestore();
    });

    it('returns false and warns when project not found in state', async () => {
      const deps = createMockDeps();
      const pipeline = new HookEventPipeline(deps);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await pipeline.handleOpencodeEvent({ projectName: 'unknown', type: 'session.start' })).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('project not found: unknown'));
      warnSpy.mockRestore();
    });

    it('returns false and warns when no channelId resolved', async () => {
      const deps = createMockDeps();
      const { getPrimaryInstanceForAgent } = await import('../../src/state/instances.js');
      (getPrimaryInstanceForAgent as any).mockReturnValueOnce(undefined);
      const pipeline = new HookEventPipeline(deps);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await pipeline.handleOpencodeEvent({ projectName: 'myProject', type: 'session.start' })).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no channel for myProject'));
      warnSpy.mockRestore();
    });

    it('routes to correct handler for known event types', async () => {
      const deps = createMockDeps();
      const pipeline = new HookEventPipeline(deps);
      const result = await pipeline.handleOpencodeEvent({
        projectName: 'myProject',
        type: 'session.error',
        text: 'something broke',
      });
      expect(result).toBe(true);
      expect(deps.messaging.sendToChannel).toHaveBeenCalled();
    });

    it('returns true for unknown event types (no handler)', async () => {
      const deps = createMockDeps();
      const pipeline = new HookEventPipeline(deps);
      const result = await pipeline.handleOpencodeEvent({
        projectName: 'myProject',
        type: 'unknown.event',
      });
      expect(result).toBe(true);
    });

    it('auto-creates pending for tool.activity when none exists', async () => {
      const deps = createMockDeps();
      const pipeline = new HookEventPipeline(deps);
      await pipeline.handleOpencodeEvent({
        projectName: 'myProject',
        type: 'tool.activity',
        text: 'Reading file...',
      });
      expect(deps.pendingTracker.ensurePending).toHaveBeenCalled();
    });

    it('auto-creates pending for session.idle when none exists', async () => {
      const deps = createMockDeps();
      const pipeline = new HookEventPipeline(deps);
      await pipeline.handleOpencodeEvent({
        projectName: 'myProject',
        type: 'session.idle',
        text: 'Done',
      });
      expect(deps.pendingTracker.ensurePending).toHaveBeenCalled();
    });

    it('passes submittedPrompt to start message creation on tmux-initiated session.idle', async () => {
      const deps = createMockDeps();
      (deps.pendingTracker.hasPending as any).mockReturnValue(true);
      (deps.pendingTracker.getPending as any).mockReturnValue({
        channelId: 'ch-1',
        messageId: '',
      });
      const pipeline = new HookEventPipeline(deps);
      await pipeline.handleOpencodeEvent({
        projectName: 'myProject',
        type: 'session.idle',
        text: 'Done',
        submittedPrompt: 'tmux prompt raw text',
      });
      expect(deps.pendingTracker.ensureStartMessage).toHaveBeenCalledWith(
        'myProject',
        'opencode',
        'primary',
        'tmux prompt raw text',
      );
    });

    it('handles prompt.submit for supported agent hook', async () => {
      const deps = createMockDeps();
      const { getPrimaryInstanceForAgent } = await import('../../src/state/instances.js');
      (getPrimaryInstanceForAgent as any).mockReturnValueOnce({
        instanceId: 'claude',
        agentType: 'claude',
        channelId: 'ch-1',
      });
      const pipeline = new HookEventPipeline(deps);
      await pipeline.handleOpencodeEvent({
        projectName: 'myProject',
        agentType: 'claude',
        type: 'prompt.submit',
        text: 'Fix login bug',
      });
      expect(deps.pendingTracker.ensurePending).toHaveBeenCalled();
      expect(deps.messaging.sendToChannel).toHaveBeenCalled();
    });

    it('passes prompt.submit when hook is unsupported by agent', async () => {
      const deps = createMockDeps();
      const pipeline = new HookEventPipeline(deps);
      const result = await pipeline.handleOpencodeEvent({
        projectName: 'myProject',
        agentType: 'opencode',
        type: 'prompt.submit',
        text: 'Fix login bug',
      });
      expect(result).toBe(true);
      expect(deps.pendingTracker.ensurePending).not.toHaveBeenCalled();
      expect(deps.messaging.sendToChannel).not.toHaveBeenCalled();
    });

    it('resolves instanceId from event payload', async () => {
      const deps = createMockDeps();
      const pipeline = new HookEventPipeline(deps);
      await pipeline.handleOpencodeEvent({
        projectName: 'myProject',
        type: 'session.error',
        instanceId: 'inst-1',
        text: 'error',
      });
      expect(deps.messaging.sendToChannel).toHaveBeenCalled();
    });
  });

  describe('getEventText (via handleOpencodeEvent)', () => {
    it('prefers text field over message field', async () => {
      const deps = createMockDeps();
      const pipeline = new HookEventPipeline(deps);
      await pipeline.handleOpencodeEvent({
        projectName: 'myProject',
        type: 'session.error',
        text: 'from text',
        message: 'from message',
      });
      const call = (deps.messaging.sendToChannel as any).mock.calls[0];
      expect(call[1]).toContain('from text');
    });

    it('falls back to message field when text is empty', async () => {
      const deps = createMockDeps();
      const pipeline = new HookEventPipeline(deps);
      await pipeline.handleOpencodeEvent({
        projectName: 'myProject',
        type: 'session.error',
        text: '',
        message: 'from message',
      });
      const call = (deps.messaging.sendToChannel as any).mock.calls[0];
      expect(call[1]).toContain('from message');
    });
  });

  describe('channel queue serialization', () => {
    it('serializes events for the same channel', async () => {
      const deps = createMockDeps();
      const order: number[] = [];
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>((r) => { resolveFirst = r; });

      (deps.messaging.sendToChannel as any).mockImplementationOnce(async () => {
        order.push(1);
        await firstPromise;
      }).mockImplementationOnce(async () => {
        order.push(2);
      });

      const pipeline = new HookEventPipeline(deps);
      const p1 = pipeline.handleOpencodeEvent({ projectName: 'myProject', type: 'session.error', text: 'err1' });
      const p2 = pipeline.handleOpencodeEvent({ projectName: 'myProject', type: 'session.error', text: 'err2' });

      resolveFirst!();
      await Promise.all([p1, p2]);
      expect(order).toEqual([1, 2]);
    });
  });

  describe('stop', () => {
    it('clears thinking timers and session lifecycle timers', async () => {
      const deps = createMockDeps();
      const pipeline = new HookEventPipeline(deps);

      // Trigger a thinking.start to create a timer
      (deps.pendingTracker.getPending as any).mockReturnValue({ channelId: 'ch-1', messageId: 'msg-1' });
      await pipeline.handleOpencodeEvent({
        projectName: 'myProject',
        type: 'thinking.start',
      });

      // stop should clean up without errors
      pipeline.stop();
    });
  });
});
