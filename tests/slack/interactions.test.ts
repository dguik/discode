import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SlackInteractions } from '../../src/slack/interactions.js';

function createMockApp() {
  return {
    client: {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '200.000' }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      conversations: {
        history: vi.fn().mockResolvedValue({ messages: [] }),
      },
    },
    action: vi.fn(),
  } as any;
}

function createMockChannels() {
  return {
    getChannelMapping: vi.fn().mockReturnValue(
      new Map([['C001', { projectName: 'proj', agentType: 'opencode' }]]),
    ),
    lastSeenTs: new Map([['C001', '123.000']]),
  } as any;
}

describe('SlackInteractions', () => {
  let app: ReturnType<typeof createMockApp>;
  let mockChannels: ReturnType<typeof createMockChannels>;
  let interactions: SlackInteractions;
  const token = 'xoxb-test-token';

  beforeEach(() => {
    app = createMockApp();
    mockChannels = createMockChannels();
    interactions = new SlackInteractions(app, token, mockChannels);
  });

  describe('sendApprovalRequest', () => {
    it('posts a message with approval blocks', async () => {
      // Do not await the full promise since it blocks on action handlers;
      // just verify the postMessage call was made.
      const promise = interactions.sendApprovalRequest('C001', 'bash', { cmd: 'ls' });

      // Allow the initial postMessage to resolve
      await vi.waitFor(() => {
        expect(app.client.chat.postMessage).toHaveBeenCalledTimes(1);
      });

      const call = app.client.chat.postMessage.mock.calls[0][0];
      expect(call.token).toBe(token);
      expect(call.channel).toBe('C001');
      expect(call.text).toContain('bash');
      expect(call.blocks).toHaveLength(2);
      expect(call.blocks[0].type).toBe('section');
      expect(call.blocks[1].type).toBe('actions');

      // Verify action handlers were registered
      expect(app.action).toHaveBeenCalledWith('approve_action', expect.any(Function));
      expect(app.action).toHaveBeenCalledWith('deny_action', expect.any(Function));

      // Clean up: simulate an action to resolve the pending promise
      const approveHandler = app.action.mock.calls.find(
        (c: any[]) => c[0] === 'approve_action',
      )![1];
      await approveHandler({
        action: { value: 'approve' },
        ack: vi.fn(),
        respond: vi.fn().mockResolvedValue(undefined),
      });

      expect(await promise).toBe(true);
    });

    it('returns false when postMessage returns no ts', async () => {
      app.client.chat.postMessage.mockResolvedValueOnce({ ts: undefined });

      const result = await interactions.sendApprovalRequest('C001', 'bash', {});
      expect(result).toBe(false);
    });

    it('truncates long tool input in the preview', async () => {
      const longInput = 'x'.repeat(600);

      const promise = interactions.sendApprovalRequest('C001', 'bash', longInput);

      await vi.waitFor(() => {
        expect(app.client.chat.postMessage).toHaveBeenCalledTimes(1);
      });

      const call = app.client.chat.postMessage.mock.calls[0][0];
      const blockText = call.blocks[0].text.text;
      expect(blockText).toContain('...');

      // Clean up
      const handler = app.action.mock.calls.find(
        (c: any[]) => c[0] === 'deny_action',
      )![1];
      await handler({
        action: { value: 'deny' },
        ack: vi.fn(),
        respond: vi.fn().mockResolvedValue(undefined),
      });

      expect(await promise).toBe(false);
    });
  });

  describe('sendQuestionWithButtons', () => {
    it('returns null for empty questions array', async () => {
      const result = await interactions.sendQuestionWithButtons('C001', []);
      expect(result).toBeNull();
      expect(app.client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('posts a message with question blocks and option buttons', async () => {
      const questions = [
        {
          question: 'Pick a color',
          header: 'Color Choice',
          options: [
            { label: 'Red', description: 'A warm color' },
            { label: 'Blue', description: 'A cool color' },
          ],
        },
      ];

      const promise = interactions.sendQuestionWithButtons('C001', questions);

      await vi.waitFor(() => {
        expect(app.client.chat.postMessage).toHaveBeenCalledTimes(1);
      });

      const call = app.client.chat.postMessage.mock.calls[0][0];
      expect(call.token).toBe(token);
      expect(call.channel).toBe('C001');
      expect(call.text).toBe('Pick a color');
      // Should have section block, description fields block, and actions block
      expect(call.blocks.length).toBeGreaterThanOrEqual(2);

      // Verify action handlers registered for each option
      expect(app.action).toHaveBeenCalledWith('opt_0', expect.any(Function));
      expect(app.action).toHaveBeenCalledWith('opt_1', expect.any(Function));

      // Clean up: simulate selecting the first option
      const handler = app.action.mock.calls.find(
        (c: any[]) => c[0] === 'opt_0',
      )![1];
      await handler({
        action: { value: 'Red' },
        ack: vi.fn(),
      });

      expect(await promise).toBe('Red');
    });

    it('returns null when postMessage returns no ts', async () => {
      app.client.chat.postMessage.mockResolvedValueOnce({ ts: undefined });

      const questions = [
        {
          question: 'Pick one',
          options: [{ label: 'A' }],
        },
      ];

      const result = await interactions.sendQuestionWithButtons('C001', questions);
      expect(result).toBeNull();
    });
  });

  describe('pollMissedMessages', () => {
    it('returns early when messageCallback is undefined', async () => {
      await interactions.pollMissedMessages(undefined, vi.fn());

      expect(app.client.conversations.history).not.toHaveBeenCalled();
    });

    it('calls conversations.history for each mapped channel', async () => {
      const messageCallback = vi.fn();
      const handleIncoming = vi.fn();

      await interactions.pollMissedMessages(messageCallback, handleIncoming);

      expect(app.client.conversations.history).toHaveBeenCalledWith({
        token,
        channel: 'C001',
        oldest: '123.000',
        limit: 20,
      });
    });

    it('dispatches messages in chronological order via handleIncomingMessage', async () => {
      app.client.conversations.history.mockResolvedValueOnce({
        messages: [
          { ts: '125.000', text: 'newer' },
          { ts: '124.000', text: 'older' },
        ],
      });

      const messageCallback = vi.fn();
      const handleIncoming = vi.fn();

      await interactions.pollMissedMessages(messageCallback, handleIncoming);

      // Messages should be dispatched in reverse order (oldest first)
      expect(handleIncoming).toHaveBeenCalledTimes(2);
      expect(handleIncoming.mock.calls[0][0]).toEqual(
        expect.objectContaining({ ts: '124.000', text: 'older', channel: 'C001' }),
      );
      expect(handleIncoming.mock.calls[1][0]).toEqual(
        expect.objectContaining({ ts: '125.000', text: 'newer', channel: 'C001' }),
      );
    });

    it('skips the message with ts equal to oldest (already seen)', async () => {
      app.client.conversations.history.mockResolvedValueOnce({
        messages: [
          { ts: '124.000', text: 'new' },
          { ts: '123.000', text: 'already seen' },
        ],
      });

      const messageCallback = vi.fn();
      const handleIncoming = vi.fn();

      await interactions.pollMissedMessages(messageCallback, handleIncoming);

      expect(handleIncoming).toHaveBeenCalledTimes(1);
      expect(handleIncoming.mock.calls[0][0].ts).toBe('124.000');
    });

    it('skips channels without a lastSeenTs entry', async () => {
      mockChannels.getChannelMapping.mockReturnValue(
        new Map([
          ['C001', { projectName: 'proj', agentType: 'opencode' }],
          ['C002', { projectName: 'proj', agentType: 'claude' }],
        ]),
      );
      // Only C001 has a lastSeenTs; C002 does not
      mockChannels.lastSeenTs = new Map([['C001', '123.000']]);

      const messageCallback = vi.fn();
      const handleIncoming = vi.fn();

      await interactions.pollMissedMessages(messageCallback, handleIncoming);

      expect(app.client.conversations.history).toHaveBeenCalledTimes(1);
      expect(app.client.conversations.history).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'C001' }),
      );
    });

    it('does not throw when conversations.history fails', async () => {
      app.client.conversations.history.mockRejectedValueOnce(new Error('api error'));

      const messageCallback = vi.fn();
      const handleIncoming = vi.fn();

      await expect(
        interactions.pollMissedMessages(messageCallback, handleIncoming),
      ).resolves.toBeUndefined();
    });
  });
});
