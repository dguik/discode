/**
 * Tests for DiscordMessaging
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordMessaging } from '../../src/discord/messaging.js';

vi.mock('discord.js', () => ({
  TextChannel: class {},
  AttachmentBuilder: class MockAttachmentBuilder {
    path: string;
    constructor(path: string) { this.path = path; }
  },
  ChannelType: { GuildText: 0 },
}));

function createMockClient() {
  const mockMessage = {
    id: 'msg-1',
    reply: vi.fn().mockResolvedValue({ id: 'reply-1' }),
    edit: vi.fn().mockResolvedValue(undefined),
    react: vi.fn().mockResolvedValue(undefined),
    reactions: { cache: { find: vi.fn().mockReturnValue(null) } },
  };
  const mockChannel = {
    isTextBased: () => true,
    send: vi.fn().mockResolvedValue(mockMessage),
    messages: { fetch: vi.fn().mockResolvedValue(mockMessage) },
  };
  const client = {
    channels: { fetch: vi.fn().mockResolvedValue(mockChannel) },
    user: { id: 'bot-user-id' },
  } as any;
  return { client, mockChannel, mockMessage };
}

describe('DiscordMessaging', () => {
  let messaging: DiscordMessaging;
  let client: any;
  let mockChannel: any;
  let mockMessage: any;

  beforeEach(() => {
    ({ client, mockChannel, mockMessage } = createMockClient());
    messaging = new DiscordMessaging(client);
  });

  // ---------- sendToChannel ----------

  describe('sendToChannel', () => {
    it('fetches the channel and sends content', async () => {
      await messaging.sendToChannel('ch-1', 'hello');

      expect(client.channels.fetch).toHaveBeenCalledWith('ch-1');
      expect(mockChannel.send).toHaveBeenCalledWith('hello');
    });

    it('warns and returns when the channel is not text-based', async () => {
      const nonTextChannel = { isTextBased: () => false };
      client.channels.fetch.mockResolvedValueOnce(nonTextChannel);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await messaging.sendToChannel('ch-1', 'hello');

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not a text channel'));
      expect(mockChannel.send).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('logs an error when the fetch rejects', async () => {
      client.channels.fetch.mockRejectedValueOnce(new Error('network'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await messaging.sendToChannel('ch-1', 'hello');

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to send message'),
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });
  });

  // ---------- sendToChannelWithId ----------

  describe('sendToChannelWithId', () => {
    it('returns the id of the sent message', async () => {
      const id = await messaging.sendToChannelWithId('ch-1', 'hi');

      expect(id).toBe('msg-1');
      expect(mockChannel.send).toHaveBeenCalledWith('hi');
    });

    it('returns undefined for a non-text channel', async () => {
      client.channels.fetch.mockResolvedValueOnce({ isTextBased: () => false });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const id = await messaging.sendToChannelWithId('ch-1', 'hi');
      expect(id).toBeUndefined();
    });

    it('returns undefined on fetch error', async () => {
      client.channels.fetch.mockRejectedValueOnce(new Error('boom'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const id = await messaging.sendToChannelWithId('ch-1', 'hi');
      expect(id).toBeUndefined();
    });
  });

  // ---------- replyInThread ----------

  describe('replyInThread', () => {
    it('fetches the parent message and calls reply', async () => {
      await messaging.replyInThread('ch-1', 'parent-1', 'reply content');

      expect(mockChannel.messages.fetch).toHaveBeenCalledWith('parent-1');
      expect(mockMessage.reply).toHaveBeenCalledWith('reply content');
    });

    it('returns early when the channel is not text-based', async () => {
      client.channels.fetch.mockResolvedValueOnce({ isTextBased: () => false });

      await messaging.replyInThread('ch-1', 'parent-1', 'reply content');

      expect(mockMessage.reply).not.toHaveBeenCalled();
    });

    it('returns early when channel has no messages property', async () => {
      client.channels.fetch.mockResolvedValueOnce({ isTextBased: () => true });

      await messaging.replyInThread('ch-1', 'parent-1', 'reply content');

      expect(mockMessage.reply).not.toHaveBeenCalled();
    });
  });

  // ---------- replyInThreadWithId ----------

  describe('replyInThreadWithId', () => {
    it('returns the reply message id', async () => {
      const id = await messaging.replyInThreadWithId('ch-1', 'parent-1', 'text');

      expect(id).toBe('reply-1');
      expect(mockMessage.reply).toHaveBeenCalledWith('text');
    });

    it('returns undefined for non-text channel', async () => {
      client.channels.fetch.mockResolvedValueOnce({ isTextBased: () => false });

      const id = await messaging.replyInThreadWithId('ch-1', 'parent-1', 'text');
      expect(id).toBeUndefined();
    });

    it('returns undefined on error', async () => {
      client.channels.fetch.mockRejectedValueOnce(new Error('err'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const id = await messaging.replyInThreadWithId('ch-1', 'parent-1', 'text');
      expect(id).toBeUndefined();
    });
  });

  // ---------- updateMessage ----------

  describe('updateMessage', () => {
    it('fetches the message and calls edit', async () => {
      await messaging.updateMessage('ch-1', 'msg-1', 'updated');

      expect(mockChannel.messages.fetch).toHaveBeenCalledWith('msg-1');
      expect(mockMessage.edit).toHaveBeenCalledWith('updated');
    });

    it('returns early when channel is not text-based', async () => {
      client.channels.fetch.mockResolvedValueOnce({ isTextBased: () => false });

      await messaging.updateMessage('ch-1', 'msg-1', 'updated');

      expect(mockMessage.edit).not.toHaveBeenCalled();
    });

    it('logs error on failure', async () => {
      client.channels.fetch.mockRejectedValueOnce(new Error('fail'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await messaging.updateMessage('ch-1', 'msg-1', 'updated');

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update message'),
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });
  });

  // ---------- sendToChannelWithFiles ----------

  describe('sendToChannelWithFiles', () => {
    it('sends content with files', async () => {
      await messaging.sendToChannelWithFiles('ch-1', 'files here', ['/a.txt', '/b.png']);

      expect(mockChannel.send).toHaveBeenCalledTimes(1);
      const call = mockChannel.send.mock.calls[0][0];
      expect(call.content).toBe('files here');
      expect(call.files).toHaveLength(2);
    });

    it('sends undefined content when content is empty string', async () => {
      await messaging.sendToChannelWithFiles('ch-1', '', ['/a.txt']);

      const call = mockChannel.send.mock.calls[0][0];
      expect(call.content).toBeUndefined();
    });

    it('warns when channel is not text-based', async () => {
      client.channels.fetch.mockResolvedValueOnce({ isTextBased: () => false });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await messaging.sendToChannelWithFiles('ch-1', 'txt', ['/a.txt']);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not a text channel'));
      expect(mockChannel.send).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // ---------- addReactionToMessage ----------

  describe('addReactionToMessage', () => {
    it('fetches the message and calls react', async () => {
      await messaging.addReactionToMessage('ch-1', 'msg-1', '👍');

      expect(mockChannel.messages.fetch).toHaveBeenCalledWith('msg-1');
      expect(mockMessage.react).toHaveBeenCalledWith('👍');
    });

    it('returns early when channel is not text-based', async () => {
      client.channels.fetch.mockResolvedValueOnce({ isTextBased: () => false });

      await messaging.addReactionToMessage('ch-1', 'msg-1', '👍');

      expect(mockMessage.react).not.toHaveBeenCalled();
    });
  });

  // ---------- replaceOwnReactionOnMessage ----------

  describe('replaceOwnReactionOnMessage', () => {
    it('removes the old reaction and adds the new one', async () => {
      const mockRemove = vi.fn().mockResolvedValue(undefined);
      const fromReaction = {
        emoji: { name: '⏳' },
        users: { remove: mockRemove },
      };
      mockMessage.reactions.cache.find.mockReturnValueOnce(fromReaction);

      await messaging.replaceOwnReactionOnMessage('ch-1', 'msg-1', '⏳', '✅');

      expect(mockRemove).toHaveBeenCalledWith('bot-user-id');
      expect(mockMessage.react).toHaveBeenCalledWith('✅');
    });

    it('still adds new reaction when old reaction is not found', async () => {
      mockMessage.reactions.cache.find.mockReturnValueOnce(null);

      await messaging.replaceOwnReactionOnMessage('ch-1', 'msg-1', '⏳', '✅');

      expect(mockMessage.react).toHaveBeenCalledWith('✅');
    });

    it('still adds new reaction when remove fails', async () => {
      const fromReaction = {
        emoji: { name: '⏳' },
        users: { remove: vi.fn().mockRejectedValue(new Error('perm')) },
      };
      mockMessage.reactions.cache.find.mockReturnValueOnce(fromReaction);

      await messaging.replaceOwnReactionOnMessage('ch-1', 'msg-1', '⏳', '✅');

      expect(mockMessage.react).toHaveBeenCalledWith('✅');
    });
  });
});
