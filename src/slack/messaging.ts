/**
 * Slack message sending — replies, updates, files, reactions.
 * Isolated so changes to text messaging don't affect file handling and vice versa.
 */

import type { App } from '@slack/bolt';

export class SlackMessaging {
  constructor(private app: App, private botToken: string) {}

  async sendToChannel(channelId: string, content: string): Promise<void> {
    try {
      await this.app.client.chat.postMessage({
        token: this.botToken,
        channel: channelId,
        text: content,
      });
    } catch (error) {
      console.error(`Failed to send message to Slack channel ${channelId}:`, error);
    }
  }

  async sendToChannelWithId(channelId: string, content: string): Promise<string | undefined> {
    try {
      const result = await this.app.client.chat.postMessage({
        token: this.botToken,
        channel: channelId,
        text: content,
      });
      return result.ts;
    } catch (error) {
      console.error(`Failed to send message to Slack channel ${channelId}:`, error);
      return undefined;
    }
  }

  async replyInThread(channelId: string, parentMessageId: string, content: string): Promise<void> {
    try {
      const result = await this.app.client.chat.postMessage({
        token: this.botToken,
        channel: channelId,
        thread_ts: parentMessageId,
        text: content,
      });
      console.log(`🧵 replyInThread OK: channel=${channelId} thread_ts=${parentMessageId} result_ts=${result.ts} content=${content.substring(0, 80)}`);
    } catch (error) {
      console.error(`🧵 replyInThread FAILED: channel=${channelId} thread_ts=${parentMessageId}:`, error);
    }
  }

  async replyInThreadWithId(channelId: string, parentMessageId: string, content: string): Promise<string | undefined> {
    try {
      const result = await this.app.client.chat.postMessage({
        token: this.botToken,
        channel: channelId,
        thread_ts: parentMessageId,
        text: content,
      });
      return result.ts;
    } catch (error) {
      console.error(`Failed to reply in thread on Slack channel ${channelId}:`, error);
      return undefined;
    }
  }

  async updateMessage(channelId: string, messageId: string, content: string): Promise<void> {
    try {
      await this.app.client.chat.update({
        token: this.botToken,
        channel: channelId,
        ts: messageId,
        text: content,
      });
    } catch (error) {
      console.error(`Failed to update message on Slack channel ${channelId}:`, error);
    }
  }

  async sendToChannelWithFiles(channelId: string, content: string, filePaths: string[]): Promise<void> {
    try {
      const { createReadStream } = await import('fs');
      const { basename } = await import('path');

      let comment = content;
      for (const filePath of filePaths) {
        await this.app.client.filesUploadV2({
          token: this.botToken,
          channel_id: channelId,
          file: createReadStream(filePath),
          filename: basename(filePath),
          initial_comment: comment || undefined,
        });
        // Only add initial_comment on the first file
        comment = '';
      }
    } catch (error) {
      console.error(`Failed to send files to Slack channel ${channelId}:`, error);
    }
  }

  async addReactionToMessage(channelId: string, messageId: string, emoji: string): Promise<void> {
    try {
      const slackEmoji = emojiToSlackName(emoji);
      await this.app.client.reactions.add({
        token: this.botToken,
        channel: channelId,
        timestamp: messageId,
        name: slackEmoji,
      });
    } catch (error) {
      console.warn(`Failed to add reaction ${emoji} on ${channelId}/${messageId}:`, error);
    }
  }

  async replaceOwnReactionOnMessage(channelId: string, messageId: string, fromEmoji: string, toEmoji: string): Promise<void> {
    try {
      const fromSlack = emojiToSlackName(fromEmoji);
      await this.app.client.reactions.remove({
        token: this.botToken,
        channel: channelId,
        timestamp: messageId,
        name: fromSlack,
      }).catch(() => undefined);

      const toSlack = emojiToSlackName(toEmoji);
      await this.app.client.reactions.add({
        token: this.botToken,
        channel: channelId,
        timestamp: messageId,
        name: toSlack,
      });
    } catch (error) {
      console.warn(`Failed to replace reaction on ${channelId}/${messageId}:`, error);
    }
  }
}

/** Map Unicode emoji to Slack emoji name (without colons). */
function emojiToSlackName(emoji: string): string {
  const map: Record<string, string> = {
    '⏳': 'hourglass_flowing_sand',
    '✅': 'white_check_mark',
    '❌': 'x',
    '⚠️': 'warning',
    '🔒': 'lock',
    '🧠': 'brain',
  };
  return map[emoji] || emoji.replace(/:/g, '');
}
