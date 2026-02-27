/**
 * E2E tests for the full event lifecycle.
 *
 * Strategy: Real HookServer + real EventPipeline + real PendingMessageTracker +
 * real StreamingMessageUpdater, with a mock MessagingClient.
 *
 * Events are sent via HTTP POST to /opencode-event.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  startFullHookServer,
  postEvent,
  waitForCalls,
  getChannelMessages,
  type FullHookServerResult,
} from './e2e-helpers.js';

describe('Event Lifecycle E2E', () => {
  let ctx: FullHookServerResult;

  beforeEach(async () => {
    ctx = await startFullHookServer({ projectName: 'test-proj', channelId: 'ch-1' });
  });

  afterEach(() => {
    ctx.server.stop();
  });

  // ---------------------------------------------------------------------------
  // Happy path: message -> processing -> response
  // ---------------------------------------------------------------------------

  describe('Happy path: message -> processing -> response', () => {
    it('full cycle: markPending -> thinking.start -> tool.activity -> session.idle -> response posted', async () => {
      // 1. markPending on real tracker (adds ⏳ reaction)
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');

      // 2. POST thinking.start — triggers ensureStartMessage and adds 🧠 reaction
      await postEvent(ctx.port, { projectName: 'test-proj', type: 'thinking.start', agentType: 'claude' });

      // 3. POST tool.activity — appends to streaming message
      await postEvent(ctx.port, { projectName: 'test-proj', type: 'tool.activity', agentType: 'claude', text: 'Reading file.ts' });

      // 4. POST session.idle — finalizes and posts response text
      await postEvent(ctx.port, { projectName: 'test-proj', type: 'session.idle', agentType: 'claude', text: 'Done! Here is the result.' });

      // Wait for sendToChannel to be called (response text)
      await waitForCalls(ctx.messaging.sendToChannel as any, 1);

      // Verify: ⏳ reaction on markPending
      expect(ctx.messaging.addReactionToMessage).toHaveBeenCalledWith('ch-1', 'user-msg-1', '⏳');

      // Verify: 🧠 reaction added on thinking.start
      expect(ctx.messaging.addReactionToMessage).toHaveBeenCalledWith('ch-1', 'user-msg-1', '🧠');

      // Verify: ⏳ -> ✅ reaction replacement on markCompleted
      expect(ctx.messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith('ch-1', 'user-msg-1', '⏳', '✅');

      // Verify: response text posted to channel
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      expect(messages.some(m => m.includes('Done! Here is the result.'))).toBe(true);
    });

    it('session.idle with response text posts text to channel', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
      await postEvent(ctx.port, { projectName: 'test-proj', type: 'session.idle', agentType: 'claude', text: 'Hello world' });

      await waitForCalls(ctx.messaging.sendToChannel as any, 1);
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      expect(messages.some(m => m.includes('Hello world'))).toBe(true);
    });

    it('session.idle with usage reports token count in finalize header', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');

      // tool.activity triggers ensureStartMessage so finalize has a startMessageId to work with
      await postEvent(ctx.port, { projectName: 'test-proj', type: 'tool.activity', agentType: 'claude', text: 'Working...' });

      await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'session.idle',
        agentType: 'claude',
        text: 'Done',
        usage: { inputTokens: 1000, outputTokens: 500, totalCostUsd: 0.05 },
      });

      // finalize posts usage summary as a new channel message
      await waitForCalls(ctx.messaging.sendToChannel as any, 2);
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      const finalizeMessage = messages.find(
        (m) => typeof m === 'string' && (m.includes('tokens') || m.includes('Done')),
      );
      expect(finalizeMessage).toBeDefined();
      expect(finalizeMessage).toContain('1,500 tokens');
      expect(finalizeMessage).toContain('$0.05');
    });

    it('session.idle with promptQuestions triggers sendQuestionWithButtons', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
      await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'session.idle',
        agentType: 'claude',
        promptQuestions: [{ question: 'Pick one?', options: [{ label: 'A' }, { label: 'B' }] }],
      });

      // sendQuestionWithButtons is fire-and-forget, wait for it to be called
      await waitForCalls(ctx.messaging.sendQuestionWithButtons as any, 1);
      expect(ctx.messaging.sendQuestionWithButtons).toHaveBeenCalledWith(
        'ch-1',
        expect.arrayContaining([expect.objectContaining({ question: 'Pick one?' })]),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Error and abort flows
  // ---------------------------------------------------------------------------

  describe('Error and abort flows', () => {
    it('session.error posts error message and marks ❌', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
      await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'session.error',
        agentType: 'claude',
        text: 'Something went wrong',
      });

      await waitForCalls(ctx.messaging.sendToChannel as any, 1);
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      expect(messages.some(m => m.includes('Error') && m.includes('Something went wrong'))).toBe(true);
      expect(ctx.messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith('ch-1', 'user-msg-1', '⏳', '❌');
    });

    it('session.error includes recent activity context', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');

      // Create some tool activity first (stored in activityHistory)
      await postEvent(ctx.port, { projectName: 'test-proj', type: 'tool.activity', agentType: 'claude', text: 'Reading src/main.ts' });
      await postEvent(ctx.port, { projectName: 'test-proj', type: 'tool.activity', agentType: 'claude', text: 'Editing src/main.ts' });

      // Then post error — it collects recent activity lines for context
      await postEvent(ctx.port, { projectName: 'test-proj', type: 'session.error', agentType: 'claude', text: 'Compile failed' });

      await waitForCalls(ctx.messaging.sendToChannel as any, 1);
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      const errorMsg = messages.find(m => m.includes('Error'));
      expect(errorMsg).toBeDefined();
      expect(errorMsg).toContain('Recent activity');
      expect(errorMsg).toContain('Reading src/main.ts');
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-event sequences
  // ---------------------------------------------------------------------------

  describe('Multi-event sequences', () => {
    it('thinking.start -> thinking.stop -> tool.activity -> session.idle full chain', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');

      await postEvent(ctx.port, { projectName: 'test-proj', type: 'thinking.start', agentType: 'claude' });
      await postEvent(ctx.port, { projectName: 'test-proj', type: 'thinking.stop', agentType: 'claude' });
      await postEvent(ctx.port, { projectName: 'test-proj', type: 'tool.activity', agentType: 'claude', text: 'Working...' });
      await postEvent(ctx.port, { projectName: 'test-proj', type: 'session.idle', agentType: 'claude', text: 'All done' });

      await waitForCalls(ctx.messaging.sendToChannel as any, 1);

      // Response text posted successfully — chain completed without errors
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      expect(messages.some(m => m.includes('All done'))).toBe(true);

      // ⏳ -> ✅ replacement on markCompleted
      expect(ctx.messaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith('ch-1', 'user-msg-1', '⏳', '✅');
    });

    it('multiple tool.activity events append to activity history', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');

      await postEvent(ctx.port, { projectName: 'test-proj', type: 'tool.activity', agentType: 'claude', text: 'Step 1' });
      await postEvent(ctx.port, { projectName: 'test-proj', type: 'tool.activity', agentType: 'claude', text: 'Step 2' });
      await postEvent(ctx.port, { projectName: 'test-proj', type: 'tool.activity', agentType: 'claude', text: 'Step 3' });

      // Error should include all accumulated activity in its context
      await postEvent(ctx.port, { projectName: 'test-proj', type: 'session.error', agentType: 'claude', text: 'Failed' });

      await waitForCalls(ctx.messaging.sendToChannel as any, 1);
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      const errorMsg = messages.find(m => m.includes('Error'));
      expect(errorMsg).toBeDefined();
      expect(errorMsg).toContain('Step 1');
      expect(errorMsg).toContain('Step 2');
      expect(errorMsg).toContain('Step 3');
    });

    it('parallel channels: events to different channels do not block each other', async () => {
      // Extend the state manager mock to also return a gemini instance for ch-2
      const stateManager = ctx.stateManager;
      const project = stateManager.getProject('test-proj')!;
      const updatedProject = {
        ...project,
        instances: {
          ...project.instances,
          gemini: { instanceId: 'gemini', agentType: 'gemini', channelId: 'ch-2', eventHook: true },
        },
        agents: { ...project.agents, gemini: true },
        discordChannels: { ...project.discordChannels, gemini: 'ch-2' },
      };
      (stateManager.getProject as any).mockImplementation((name: string) =>
        name === 'test-proj' ? updatedProject : undefined,
      );

      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'msg-a');
      await ctx.pendingTracker.markPending('test-proj', 'gemini', 'ch-2', 'msg-b');

      // Send events to both channels concurrently
      await Promise.all([
        postEvent(ctx.port, { projectName: 'test-proj', type: 'session.idle', agentType: 'claude', text: 'Response A' }),
        postEvent(ctx.port, { projectName: 'test-proj', type: 'session.idle', agentType: 'gemini', text: 'Response B' }),
      ]);

      await waitForCalls(ctx.messaging.sendToChannel as any, 2, 5000);
      const ch1Messages = getChannelMessages(ctx.messaging, 'ch-1');
      const ch2Messages = getChannelMessages(ctx.messaging, 'ch-2');
      expect(ch1Messages.some(m => m.includes('Response A'))).toBe(true);
      expect(ch2Messages.some(m => m.includes('Response B'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Structured events
  // ---------------------------------------------------------------------------

  describe('Structured events', () => {
    it('TASK_CREATE via tool.activity creates checklist message', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
      await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'tool.activity',
        agentType: 'claude',
        text: 'TASK_CREATE:' + JSON.stringify({ subject: 'Fix the bug' }),
      });

      // sendToChannelWithId is called once for the start message (ensureStartMessage)
      // and once for the task checklist (handleTaskProgress first time)
      await waitForCalls(ctx.messaging.sendToChannelWithId as any, 2);
      const sendWithIdCalls = (ctx.messaging.sendToChannelWithId as any).mock.calls;
      const checklistCall = sendWithIdCalls.find(
        (c: any[]) => typeof c[1] === 'string' && c[1].includes('Fix the bug'),
      );
      expect(checklistCall).toBeDefined();
    });

    it('GIT_COMMIT via tool.activity posts formatted commit message', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
      await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'tool.activity',
        agentType: 'claude',
        text: 'GIT_COMMIT:' + JSON.stringify({ message: 'fix: resolve null pointer', stat: '2 files changed' }),
      });

      await waitForCalls(ctx.messaging.sendToChannel as any, 1);
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      expect(messages.some(m => m.includes('Committed') && m.includes('fix: resolve null pointer'))).toBe(true);
    });

    it('SUBAGENT_DONE via tool.activity posts agent summary', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
      await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'tool.activity',
        agentType: 'claude',
        text: 'SUBAGENT_DONE:' + JSON.stringify({ subagentType: 'researcher', summary: 'Found 3 relevant files' }),
      });

      await waitForCalls(ctx.messaging.sendToChannel as any, 1);
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      expect(messages.some(m => m.includes('researcher') && m.includes('Found 3 relevant files'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  describe('Session lifecycle', () => {
    it('session.start posts start message and sets hookActive', async () => {
      // markPending first so the pending entry exists for setHookActive to mutate
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
      await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'session.start',
        agentType: 'claude',
        source: 'hook',
      });

      await waitForCalls(ctx.messaging.sendToChannel as any, 1);
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      expect(messages.some(m => m.includes('Session started'))).toBe(true);

      // setHookActive sets hookActive=true on the pending entry
      expect(ctx.pendingTracker.isHookActive('test-proj', 'claude')).toBe(true);
    });

    it('session.end posts end message', async () => {
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
      await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'session.end',
        agentType: 'claude',
        reason: 'completed',
      });

      await waitForCalls(ctx.messaging.sendToChannel as any, 1);
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      expect(messages.some(m => m.includes('Session ended'))).toBe(true);
    });

    it('session.notification posts notification message with emoji', async () => {
      // session.notification does not require a pending entry
      await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'session.notification',
        agentType: 'claude',
        notificationType: 'permission_prompt',
        text: 'Needs permission to run bash',
      });

      await waitForCalls(ctx.messaging.sendToChannel as any, 1);
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      expect(messages.some(m => m.includes('Needs permission to run bash'))).toBe(true);
    });

    it('session.idle without prior activity skips streaming finalize', async () => {
      // No tool.activity before idle means no startMessageId and no streaming entry.
      // finalize() is a no-op when there is no streaming entry, so updateMessage is not called.
      await ctx.pendingTracker.markPending('test-proj', 'claude', 'ch-1', 'user-msg-1');
      await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'session.idle',
        agentType: 'claude',
        text: 'Quick answer',
      });

      await waitForCalls(ctx.messaging.sendToChannel as any, 1);

      // updateMessage must not have been called — no start message, so no streaming to finalize
      expect(ctx.messaging.updateMessage).not.toHaveBeenCalled();

      // The response text was still posted directly to the channel
      const messages = getChannelMessages(ctx.messaging, 'ch-1');
      expect(messages.some(m => m.includes('Quick answer'))).toBe(true);
    });
  });
});
