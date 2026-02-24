import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({ createReadStream: vi.fn().mockReturnValue('mock-stream') }));
vi.mock('path', () => ({ basename: vi.fn((p: string) => p.split('/').pop()) }));

import { SlackMessaging } from '../../src/slack/messaging.js';

function createMockApp() {
  return {
    client: {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '123.456' }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      reactions: {
        add: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      filesUploadV2: vi.fn().mockResolvedValue(undefined),
    },
  } as any;
}

describe('SlackMessaging', () => {
  let app: ReturnType<typeof createMockApp>;
  let messaging: SlackMessaging;
  const token = 'xoxb-test-token';

  beforeEach(() => {
    app = createMockApp();
    messaging = new SlackMessaging(app, token);
  });

  describe('sendToChannel', () => {
    it('calls chat.postMessage with token, channel, and text', async () => {
      await messaging.sendToChannel('C001', 'hello world');

      expect(app.client.chat.postMessage).toHaveBeenCalledWith({
        token,
        channel: 'C001',
        text: 'hello world',
      });
    });

    it('does not throw when the API call fails', async () => {
      app.client.chat.postMessage.mockRejectedValueOnce(new Error('network error'));

      await expect(messaging.sendToChannel('C001', 'fail')).resolves.toBeUndefined();
    });
  });

  describe('sendToChannelWithId', () => {
    it('returns the message timestamp from the result', async () => {
      const ts = await messaging.sendToChannelWithId('C001', 'get id');

      expect(ts).toBe('123.456');
      expect(app.client.chat.postMessage).toHaveBeenCalledWith({
        token,
        channel: 'C001',
        text: 'get id',
      });
    });

    it('returns undefined when the API call fails', async () => {
      app.client.chat.postMessage.mockRejectedValueOnce(new Error('fail'));

      const ts = await messaging.sendToChannelWithId('C001', 'fail');
      expect(ts).toBeUndefined();
    });
  });

  describe('replyInThread', () => {
    it('calls chat.postMessage with thread_ts', async () => {
      await messaging.replyInThread('C001', '100.000', 'threaded reply');

      expect(app.client.chat.postMessage).toHaveBeenCalledWith({
        token,
        channel: 'C001',
        thread_ts: '100.000',
        text: 'threaded reply',
      });
    });

    it('does not throw when the API call fails', async () => {
      app.client.chat.postMessage.mockRejectedValueOnce(new Error('fail'));

      await expect(messaging.replyInThread('C001', '100.000', 'fail')).resolves.toBeUndefined();
    });
  });

  describe('replyInThreadWithId', () => {
    it('returns the message timestamp from the result', async () => {
      const ts = await messaging.replyInThreadWithId('C001', '100.000', 'reply');

      expect(ts).toBe('123.456');
      expect(app.client.chat.postMessage).toHaveBeenCalledWith({
        token,
        channel: 'C001',
        thread_ts: '100.000',
        text: 'reply',
      });
    });

    it('returns undefined when the API call fails', async () => {
      app.client.chat.postMessage.mockRejectedValueOnce(new Error('fail'));

      const ts = await messaging.replyInThreadWithId('C001', '100.000', 'fail');
      expect(ts).toBeUndefined();
    });
  });

  describe('updateMessage', () => {
    it('calls chat.update with ts and new content', async () => {
      await messaging.updateMessage('C001', '100.000', 'updated text');

      expect(app.client.chat.update).toHaveBeenCalledWith({
        token,
        channel: 'C001',
        ts: '100.000',
        text: 'updated text',
      });
    });

    it('does not throw when the API call fails', async () => {
      app.client.chat.update.mockRejectedValueOnce(new Error('fail'));

      await expect(messaging.updateMessage('C001', '100.000', 'fail')).resolves.toBeUndefined();
    });
  });

  describe('sendToChannelWithFiles', () => {
    it('calls filesUploadV2 for each file path', async () => {
      await messaging.sendToChannelWithFiles('C001', 'here are files', [
        '/tmp/a.txt',
        '/tmp/b.png',
      ]);

      expect(app.client.filesUploadV2).toHaveBeenCalledTimes(2);

      // First file includes initial_comment
      expect(app.client.filesUploadV2).toHaveBeenNthCalledWith(1, {
        token,
        channel_id: 'C001',
        file: 'mock-stream',
        filename: 'a.txt',
        initial_comment: 'here are files',
      });

      // Second file has no initial_comment (empty string becomes undefined)
      expect(app.client.filesUploadV2).toHaveBeenNthCalledWith(2, {
        token,
        channel_id: 'C001',
        file: 'mock-stream',
        filename: 'b.png',
        initial_comment: undefined,
      });
    });

    it('does not throw when the API call fails', async () => {
      app.client.filesUploadV2.mockRejectedValueOnce(new Error('upload failed'));

      await expect(
        messaging.sendToChannelWithFiles('C001', 'fail', ['/tmp/x.txt']),
      ).resolves.toBeUndefined();
    });
  });

  describe('addReactionToMessage', () => {
    it('maps unicode emoji to slack name and calls reactions.add', async () => {
      await messaging.addReactionToMessage('C001', '100.000', '✅');

      expect(app.client.reactions.add).toHaveBeenCalledWith({
        token,
        channel: 'C001',
        timestamp: '100.000',
        name: 'white_check_mark',
      });
    });

    it('passes through a plain emoji name with colons stripped', async () => {
      await messaging.addReactionToMessage('C001', '100.000', ':thumbsup:');

      expect(app.client.reactions.add).toHaveBeenCalledWith({
        token,
        channel: 'C001',
        timestamp: '100.000',
        name: 'thumbsup',
      });
    });

    it('does not throw when the API call fails', async () => {
      app.client.reactions.add.mockRejectedValueOnce(new Error('fail'));

      await expect(
        messaging.addReactionToMessage('C001', '100.000', '✅'),
      ).resolves.toBeUndefined();
    });
  });

  describe('replaceOwnReactionOnMessage', () => {
    it('removes the old reaction and adds the new one', async () => {
      await messaging.replaceOwnReactionOnMessage('C001', '100.000', '⏳', '✅');

      expect(app.client.reactions.remove).toHaveBeenCalledWith({
        token,
        channel: 'C001',
        timestamp: '100.000',
        name: 'hourglass_flowing_sand',
      });

      expect(app.client.reactions.add).toHaveBeenCalledWith({
        token,
        channel: 'C001',
        timestamp: '100.000',
        name: 'white_check_mark',
      });
    });

    it('still adds the new reaction when removing the old one fails', async () => {
      app.client.reactions.remove.mockRejectedValueOnce(new Error('not_found'));

      await messaging.replaceOwnReactionOnMessage('C001', '100.000', '⏳', '✅');

      // reactions.add should still have been called despite the remove failure
      expect(app.client.reactions.add).toHaveBeenCalledWith({
        token,
        channel: 'C001',
        timestamp: '100.000',
        name: 'white_check_mark',
      });
    });

    it('does not throw when adding the new reaction fails', async () => {
      app.client.reactions.add.mockRejectedValueOnce(new Error('fail'));

      await expect(
        messaging.replaceOwnReactionOnMessage('C001', '100.000', '⏳', '✅'),
      ).resolves.toBeUndefined();
    });
  });
});
