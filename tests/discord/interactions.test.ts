/**
 * Tests for DiscordInteractions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordInteractions } from '../../src/discord/interactions.js';

vi.mock('discord.js', () => ({
  TextChannel: class {},
  ButtonBuilder: class {
    setCustomId() { return this; }
    setLabel() { return this; }
    setStyle() { return this; }
  },
  ButtonStyle: { Primary: 1, Secondary: 2 },
  ActionRowBuilder: class {
    addComponents() { return this; }
  },
  ComponentType: { Button: 2 },
  EmbedBuilder: class {
    setTitle() { return this; }
    setDescription() { return this; }
    setColor() { return this; }
    addFields() { return this; }
    setFooter() { return this; }
  },
}));

function createMockClient() {
  const client = {
    channels: { fetch: vi.fn() },
    user: { id: 'bot-user-id' },
  } as any;
  return client;
}

describe('DiscordInteractions', () => {
  let client: any;
  let interactions: DiscordInteractions;

  beforeEach(() => {
    client = createMockClient();
    interactions = new DiscordInteractions(client);
  });

  // ---------- sendApprovalRequest ----------

  describe('sendApprovalRequest', () => {
    it('returns false when the channel is not text-based', async () => {
      client.channels.fetch.mockResolvedValueOnce({ isTextBased: () => false });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await interactions.sendApprovalRequest('ch-1', 'rm', { path: '/tmp' });

      expect(result).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not a text channel'));
      warnSpy.mockRestore();
    });

    it('returns false when the channel is null', async () => {
      client.channels.fetch.mockResolvedValueOnce(null);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await interactions.sendApprovalRequest('ch-1', 'rm', {});

      expect(result).toBe(false);
      warnSpy.mockRestore();
    });
  });

  // ---------- sendQuestionWithButtons ----------

  describe('sendQuestionWithButtons', () => {
    it('returns null when the channel is not text-based', async () => {
      client.channels.fetch.mockResolvedValueOnce({ isTextBased: () => false });

      const result = await interactions.sendQuestionWithButtons('ch-1', [
        { question: 'Pick one', options: [{ label: 'A' }] },
      ]);

      expect(result).toBeNull();
    });

    it('returns null when the channel is null', async () => {
      client.channels.fetch.mockResolvedValueOnce(null);

      const result = await interactions.sendQuestionWithButtons('ch-1', [
        { question: 'Pick one', options: [{ label: 'A' }] },
      ]);

      expect(result).toBeNull();
    });

    it('returns null when questions array is empty', async () => {
      const mockMessage = {
        awaitMessageComponent: vi.fn(),
      };
      const mockChannel = {
        isTextBased: () => true,
        send: vi.fn().mockResolvedValue(mockMessage),
      };
      client.channels.fetch.mockResolvedValueOnce(mockChannel);

      const result = await interactions.sendQuestionWithButtons('ch-1', []);

      expect(result).toBeNull();
    });
  });
});
