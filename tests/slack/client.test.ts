import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { MessageCallback } from '../../src/messaging/interface.js';

// Capture the message handler registered via app.message()
let capturedMessageHandler: ((args: { message: any }) => Promise<void>) | undefined;
// Capture the app_mention event handler registered via app.event('app_mention')
let capturedAppMentionHandler: ((args: { event: any }) => Promise<void>) | undefined;

const mockConversationsHistory = vi.fn().mockResolvedValue({ messages: [] });

vi.mock('@slack/bolt', () => {
  return {
    App: class MockApp {
      client = {
        auth: { test: vi.fn().mockResolvedValue({ user: 'bot', user_id: 'U_BOT' }) },
        chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) },
        conversations: {
          list: vi.fn().mockResolvedValue({ channels: [], response_metadata: {} }),
          create: vi.fn().mockResolvedValue({ channel: { id: 'C_NEW' } }),
          join: vi.fn().mockResolvedValue({ ok: true }),
          setTopic: vi.fn().mockResolvedValue({ ok: true }),
          history: mockConversationsHistory,
        },
        reactions: {
          add: vi.fn().mockResolvedValue({ ok: true }),
          remove: vi.fn().mockResolvedValue({ ok: true }),
        },
      };

      message(handler: any) {
        capturedMessageHandler = handler;
      }
      event(eventName: string, handler: any) {
        if (eventName === 'app_mention') {
          capturedAppMentionHandler = handler;
        }
      }
      action(_pattern: any, _handler: any) {}
      use(_middleware: any) {}
      start = vi.fn().mockResolvedValue(undefined);
      stop = vi.fn().mockResolvedValue(undefined);
    },
  };
});

import { SlackClient } from '../../src/slack/client.js';

describe('SlackClient message handling', () => {
  let client: SlackClient;
  let callback: ReturnType<typeof vi.fn<MessageCallback>>;

  beforeEach(() => {
    vi.useFakeTimers();
    capturedMessageHandler = undefined;
    capturedAppMentionHandler = undefined;
    mockConversationsHistory.mockReset().mockResolvedValue({ messages: [] });
    client = new SlackClient('xoxb-test-token', 'xapp-test-token');
    callback = vi.fn();
    client.onMessage(callback);
    client.registerChannelMappings([
      { channelId: 'C_TEST', projectName: 'proj', agentType: 'claude', instanceId: 'claude' },
    ]);
  });

  afterEach(async () => {
    await client.disconnect();
    vi.useRealTimers();
  });

  function sendMessage(message: any) {
    expect(capturedMessageHandler).toBeDefined();
    return capturedMessageHandler!({ message });
  }

  function sendAppMention(event: any) {
    expect(capturedAppMentionHandler).toBeDefined();
    return capturedAppMentionHandler!({ event });
  }

  it('processes regular text messages', async () => {
    await sendMessage({
      user: 'U_USER',
      text: 'hello',
      channel: 'C_TEST',
      ts: '1234.5678',
    });

    expect(callback).toHaveBeenCalledWith(
      'claude', 'hello', 'proj', 'C_TEST', '1234.5678', 'claude', undefined,
    );
  });

  it('ignores bot messages', async () => {
    await sendMessage({
      user: 'U_BOT',
      bot_id: 'B_BOT',
      text: 'bot says hi',
      channel: 'C_TEST',
      ts: '1234.5678',
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it('ignores system subtypes like message_changed', async () => {
    await sendMessage({
      user: 'U_USER',
      subtype: 'message_changed',
      text: 'edited',
      channel: 'C_TEST',
      ts: '1234.5678',
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it('ignores messages without user field', async () => {
    await sendMessage({
      text: 'no user',
      channel: 'C_TEST',
      ts: '1234.5678',
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it('ignores messages from unmapped channels', async () => {
    await sendMessage({
      user: 'U_USER',
      text: 'unknown channel',
      channel: 'C_UNKNOWN',
      ts: '1234.5678',
    });

    expect(callback).not.toHaveBeenCalled();
  });

  describe('app_mention events', () => {
    it('processes app_mention events', async () => {
      await sendAppMention({
        user: 'U_USER',
        text: '<@U_BOT> build the feature',
        channel: 'C_TEST',
        ts: '1234.5678',
      });

      expect(callback).toHaveBeenCalledTimes(1);
      // Bot mention should NOT be stripped here because botUserId is not set
      // (connect() was never called in this test). Text passes through as-is.
      expect(callback.mock.calls[0][1]).toBe('<@U_BOT> build the feature');
    });

    it('strips bot mention from app_mention text when botUserId is known', async () => {
      // Simulate connect() having resolved botUserId
      await client.connect();

      await sendAppMention({
        user: 'U_USER',
        text: '<@U_BOT> deploy to production',
        channel: 'C_TEST',
        ts: '1234.5678',
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][1]).toBe('deploy to production');
    });

    it('ignores app_mention from unmapped channels', async () => {
      await sendAppMention({
        user: 'U_USER',
        text: '<@U_BOT> hello',
        channel: 'C_UNKNOWN',
        ts: '1234.5678',
      });

      expect(callback).not.toHaveBeenCalled();
    });

    it('ignores app_mention without user field', async () => {
      await sendAppMention({
        text: '<@U_BOT> hello',
        channel: 'C_TEST',
        ts: '1234.5678',
      });

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('bot self-message filtering', () => {
    it('ignores own messages after connect', async () => {
      await client.connect();

      await sendMessage({
        user: 'U_BOT',
        text: 'my own message',
        channel: 'C_TEST',
        ts: '1234.5678',
      });

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('file_share messages', () => {
    it('processes file_share subtype messages', async () => {
      await sendMessage({
        user: 'U_USER',
        subtype: 'file_share',
        text: 'check this image',
        channel: 'C_TEST',
        ts: '1234.5678',
        files: [
          {
            url_private_download: 'https://files.slack.com/download/image.png',
            url_private: 'https://files.slack.com/image.png',
            name: 'screenshot.png',
            mimetype: 'image/png',
            size: 12345,
          },
        ],
      });

      expect(callback).toHaveBeenCalledTimes(1);
      const attachments = callback.mock.calls[0][6];
      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toEqual({
        url: 'https://files.slack.com/download/image.png',
        filename: 'screenshot.png',
        contentType: 'image/png',
        size: 12345,
        authHeaders: { Authorization: 'Bearer xoxb-test-token' },
      });
    });

    it('processes file_share with empty text', async () => {
      await sendMessage({
        user: 'U_USER',
        subtype: 'file_share',
        text: '',
        channel: 'C_TEST',
        ts: '1234.5678',
        files: [
          {
            url_private: 'https://files.slack.com/photo.jpg',
            name: 'photo.jpg',
            mimetype: 'image/jpeg',
            size: 5000,
          },
        ],
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][1]).toBe('');
      const attachments = callback.mock.calls[0][6];
      expect(attachments).toHaveLength(1);
      expect(attachments[0].url).toBe('https://files.slack.com/photo.jpg');
    });

    it('processes file_share without text field', async () => {
      await sendMessage({
        user: 'U_USER',
        subtype: 'file_share',
        channel: 'C_TEST',
        ts: '1234.5678',
        files: [
          {
            url_private: 'https://files.slack.com/doc.pdf',
            name: 'doc.pdf',
            mimetype: 'application/pdf',
            size: 10000,
          },
        ],
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][1]).toBe('');
    });

    it('includes auth headers with Bearer token for file downloads', async () => {
      await sendMessage({
        user: 'U_USER',
        text: 'file',
        channel: 'C_TEST',
        ts: '1234.5678',
        files: [
          {
            url_private_download: 'https://files.slack.com/dl/a.png',
            name: 'a.png',
            mimetype: 'image/png',
            size: 100,
          },
          {
            url_private: 'https://files.slack.com/b.jpg',
            name: 'b.jpg',
            mimetype: 'image/jpeg',
            size: 200,
          },
        ],
      });

      const attachments = callback.mock.calls[0][6];
      expect(attachments).toHaveLength(2);
      for (const att of attachments) {
        expect(att.authHeaders).toEqual({ Authorization: 'Bearer xoxb-test-token' });
      }
    });

    it('prefers url_private_download over url_private', async () => {
      await sendMessage({
        user: 'U_USER',
        text: '',
        channel: 'C_TEST',
        ts: '1234.5678',
        files: [
          {
            url_private_download: 'https://files.slack.com/download/file.png',
            url_private: 'https://files.slack.com/file.png',
            name: 'file.png',
            mimetype: 'image/png',
            size: 100,
          },
        ],
      });

      const attachments = callback.mock.calls[0][6];
      expect(attachments[0].url).toBe('https://files.slack.com/download/file.png');
    });
  });

  describe('regular messages with files', () => {
    it('processes messages with files but no subtype', async () => {
      await sendMessage({
        user: 'U_USER',
        text: 'look at this',
        channel: 'C_TEST',
        ts: '1234.5678',
        files: [
          {
            url_private: 'https://files.slack.com/img.png',
            name: 'img.png',
            mimetype: 'image/png',
            size: 500,
          },
        ],
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][1]).toBe('look at this');
      expect(callback.mock.calls[0][6]).toHaveLength(1);
    });

    it('passes undefined attachments when no files', async () => {
      await sendMessage({
        user: 'U_USER',
        text: 'just text',
        channel: 'C_TEST',
        ts: '1234.5678',
      });

      expect(callback.mock.calls[0][6]).toBeUndefined();
    });
  });

  describe('conversations.history polling fallback', () => {
    it('dispatches missed messages from polling', async () => {
      await client.connect();

      // Simulate a message the WebSocket missed
      mockConversationsHistory.mockResolvedValueOnce({
        messages: [
          { user: 'U_USER', text: 'missed message', ts: '9999.0001', channel: 'C_TEST' },
        ],
      });

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockConversationsHistory).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'C_TEST', limit: 20 }),
      );
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        'claude', 'missed message', 'proj', 'C_TEST', '9999.0001', 'claude', undefined,
      );
    });

    it('does not re-dispatch messages already seen via WebSocket', async () => {
      await client.connect();

      // Deliver a message via WebSocket first
      await sendMessage({
        user: 'U_USER',
        text: 'realtime msg',
        channel: 'C_TEST',
        ts: '9999.0002',
      });
      expect(callback).toHaveBeenCalledTimes(1);

      // Now polling returns the same message
      mockConversationsHistory.mockResolvedValueOnce({
        messages: [
          { user: 'U_USER', text: 'realtime msg', ts: '9999.0002', channel: 'C_TEST' },
        ],
      });

      await vi.advanceTimersByTimeAsync(5000);

      // Should NOT have dispatched again
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('skips polling when no messageCallback is registered', async () => {
      // Create a client without onMessage callback
      const noCallbackClient = new SlackClient('xoxb-test-token', 'xapp-test-token');
      noCallbackClient.registerChannelMappings([
        { channelId: 'C_TEST', projectName: 'proj', agentType: 'claude' },
      ]);
      await noCallbackClient.connect();

      await vi.advanceTimersByTimeAsync(5000);

      expect(mockConversationsHistory).not.toHaveBeenCalled();
      await noCallbackClient.disconnect();
    });

    it('clears polling timer on disconnect', async () => {
      await client.connect();

      await client.disconnect();

      // Reset the mock to verify no further calls after disconnect
      mockConversationsHistory.mockClear();
      await vi.advanceTimersByTimeAsync(10000);

      expect(mockConversationsHistory).not.toHaveBeenCalled();
    });
  });
});
