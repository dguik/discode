/**
 * Discord message sending — isolated from client core and channel management.
 */

import { TextChannel, AttachmentBuilder } from 'discord.js';
import type { Client } from 'discord.js';

export class DiscordMessaging {
  constructor(private client: Client) {}

  async sendToChannel(channelId: string, content: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) {
        console.warn(`Channel ${channelId} is not a text channel`);
        return;
      }
      await (channel as TextChannel).send(content);
    } catch (error) {
      console.error(`Failed to send message to channel ${channelId}:`, error);
    }
  }

  async sendToChannelWithId(channelId: string, content: string): Promise<string | undefined> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) {
        console.warn(`Channel ${channelId} is not a text channel`);
        return undefined;
      }
      const message = await (channel as TextChannel).send(content);
      return message.id;
    } catch (error) {
      console.error(`Failed to send message to channel ${channelId}:`, error);
      return undefined;
    }
  }

  async replyInThread(channelId: string, parentMessageId: string, content: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased() || !('messages' in channel)) return;
      const parentMessage = await (channel as TextChannel).messages.fetch(parentMessageId);
      await parentMessage.reply(content);
    } catch (error) {
      console.error(`Failed to reply in thread on Discord channel ${channelId}:`, error);
    }
  }

  async replyInThreadWithId(channelId: string, parentMessageId: string, content: string): Promise<string | undefined> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased() || !('messages' in channel)) return undefined;
      const parentMessage = await (channel as TextChannel).messages.fetch(parentMessageId);
      const reply = await parentMessage.reply(content);
      return reply.id;
    } catch (error) {
      console.error(`Failed to reply in thread on Discord channel ${channelId}:`, error);
      return undefined;
    }
  }

  async updateMessage(channelId: string, messageId: string, content: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased() || !('messages' in channel)) return;
      const message = await (channel as TextChannel).messages.fetch(messageId);
      await message.edit(content);
    } catch (error) {
      console.error(`Failed to update message on Discord channel ${channelId}:`, error);
    }
  }

  async sendToChannelWithFiles(channelId: string, content: string, filePaths: string[]): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) {
        console.warn(`Channel ${channelId} is not a text channel`);
        return;
      }
      const files = filePaths.map((fp) => new AttachmentBuilder(fp));
      await (channel as TextChannel).send({
        content: content || undefined,
        files,
      });
    } catch (error) {
      console.error(`Failed to send message with files to channel ${channelId}:`, error);
    }
  }

  async addReactionToMessage(channelId: string, messageId: string, emoji: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased() || !('messages' in channel)) return;
      const message = await (channel as TextChannel).messages.fetch(messageId);
      await message.react(emoji);
    } catch (error) {
      console.warn(`Failed to add reaction ${emoji} on ${channelId}/${messageId}:`, error);
    }
  }

  async replaceOwnReactionOnMessage(channelId: string, messageId: string, fromEmoji: string, toEmoji: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased() || !('messages' in channel)) return;
      const message = await (channel as TextChannel).messages.fetch(messageId);

      const fromReaction = message.reactions.cache.find((reaction) => reaction.emoji.name === fromEmoji);
      const botUserId = this.client.user?.id;
      if (fromReaction && botUserId) {
        await fromReaction.users.remove(botUserId).catch(() => undefined);
      }

      await message.react(toEmoji);
    } catch (error) {
      console.warn(`Failed to replace reaction on ${channelId}/${messageId}:`, error);
    }
  }
}
