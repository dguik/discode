/**
 * Tests for DiscordChannels
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordChannels } from '../../src/discord/channels.js';

vi.mock('discord.js', () => ({
  TextChannel: class {},
  AttachmentBuilder: vi.fn((path: string) => ({ path })),
  ChannelType: { GuildText: 0 },
}));

function createMockChannel(id: string, name: string, textBased = true) {
  return {
    id,
    name,
    type: 0, // ChannelType.GuildText
    isTextBased: () => textBased,
    delete: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockGuild(id: string, name: string, channels: any[] = []) {
  const channelCache = new Map(channels.map((ch) => [ch.id, ch]));
  return {
    id,
    name,
    channels: {
      cache: channelCache,
      fetch: vi.fn().mockResolvedValue(channelCache),
      create: vi.fn().mockImplementation(async (opts: any) => {
        const ch = createMockChannel(`new-${opts.name}`, opts.name.toLowerCase().replace(/\s+/g, '-'));
        return ch;
      }),
    },
  };
}

function createCollectionLikeMap<K, V>(entries: [K, V][]): Map<K, V> & { map: (fn: (v: V) => any) => any[] } {
  const m = new Map(entries) as Map<K, V> & { map: (fn: (v: V) => any) => any[], forEach: Map<K, V>['forEach'] };
  m.map = (fn: (v: V) => any) => [...m.values()].map(fn);
  return m;
}

function createMockClient(guilds: any[] = []) {
  const guildCache = createCollectionLikeMap(guilds.map((g: any) => [g.id, g] as [string, any]));
  return {
    guilds: {
      cache: guildCache,
      fetch: vi.fn().mockImplementation(async (guildId: string) => guildCache.get(guildId)),
    },
    channels: {
      fetch: vi.fn(),
    },
  } as any;
}

describe('DiscordChannels', () => {
  let client: any;
  let registry: any;
  let channels: DiscordChannels;

  beforeEach(() => {
    registry = { parseChannelName: vi.fn() };
    client = createMockClient();
    channels = new DiscordChannels(client, registry);
  });

  // ---------- registerChannelMappings ----------

  describe('registerChannelMappings', () => {
    it('adds mappings to the channel map', () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      channels.registerChannelMappings([
        { channelId: 'ch-1', projectName: 'proj', agentType: 'coder' },
        { channelId: 'ch-2', projectName: 'proj', agentType: 'reviewer', instanceId: 'i1' },
      ]);

      const map = channels.getChannelMapping();
      expect(map.size).toBe(2);
      expect(map.get('ch-1')).toEqual({ projectName: 'proj', agentType: 'coder', instanceId: undefined });
      expect(map.get('ch-2')).toEqual({ projectName: 'proj', agentType: 'reviewer', instanceId: 'i1' });
    });
  });

  // ---------- getChannelMapping ----------

  describe('getChannelMapping', () => {
    it('returns a copy of the mapping (not the same reference)', () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      channels.registerChannelMappings([
        { channelId: 'ch-1', projectName: 'proj', agentType: 'coder' },
      ]);

      const copy = channels.getChannelMapping();
      copy.set('ch-extra', { projectName: 'x', agentType: 'y' });

      expect(channels.getChannelMapping().size).toBe(1);
    });
  });

  // ---------- getGuilds ----------

  describe('getGuilds', () => {
    it('returns guilds from cache as id/name objects', () => {
      const guild1 = createMockGuild('g-1', 'Guild One');
      const guild2 = createMockGuild('g-2', 'Guild Two');
      client = createMockClient([guild1, guild2]);
      channels = new DiscordChannels(client, registry);

      const guilds = channels.getGuilds();

      expect(guilds).toEqual([
        { id: 'g-1', name: 'Guild One' },
        { id: 'g-2', name: 'Guild Two' },
      ]);
    });

    it('returns empty array when no guilds', () => {
      expect(channels.getGuilds()).toEqual([]);
    });
  });

  // ---------- parseChannelName ----------

  describe('parseChannelName', () => {
    it('delegates to registry.parseChannelName and maps result', () => {
      registry.parseChannelName.mockReturnValueOnce({
        projectName: 'myproj',
        agent: { config: { name: 'coder' } },
      });

      const result = channels.parseChannelName('myproj-code');

      expect(registry.parseChannelName).toHaveBeenCalledWith('myproj-code');
      expect(result).toEqual({ projectName: 'myproj', agentType: 'coder' });
    });

    it('returns null when registry returns null', () => {
      registry.parseChannelName.mockReturnValueOnce(null);

      const result = channels.parseChannelName('random-name');
      expect(result).toBeNull();
    });
  });

  // ---------- deleteChannel ----------

  describe('deleteChannel', () => {
    it('fetches the channel, deletes it, and removes from mapping', async () => {
      const mockCh = createMockChannel('ch-1', 'test');
      client.channels.fetch.mockResolvedValueOnce(mockCh);
      vi.spyOn(console, 'log').mockImplementation(() => {});

      channels.registerChannelMappings([
        { channelId: 'ch-1', projectName: 'proj', agentType: 'coder' },
      ]);

      const result = await channels.deleteChannel('ch-1');

      expect(result).toBe(true);
      expect(mockCh.delete).toHaveBeenCalled();
      expect(channels.getChannelMapping().has('ch-1')).toBe(false);
    });

    it('returns false when channel is not text-based', async () => {
      client.channels.fetch.mockResolvedValueOnce({ isTextBased: () => false });

      const result = await channels.deleteChannel('ch-1');
      expect(result).toBe(false);
    });

    it('returns false and logs on Unknown Channel error (code 10003)', async () => {
      const error = new Error('Unknown Channel') as any;
      error.code = 10003;
      client.channels.fetch.mockRejectedValueOnce(error);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await channels.deleteChannel('ch-gone');

      expect(result).toBe(false);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already deleted'));
      logSpy.mockRestore();
    });

    it('returns false and logs on other errors', async () => {
      client.channels.fetch.mockRejectedValueOnce(new Error('network'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await channels.deleteChannel('ch-1');

      expect(result).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to delete channel'),
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });
  });

  // ---------- scanExistingChannels ----------

  describe('scanExistingChannels', () => {
    it('iterates guild channels and maps parsable ones', () => {
      const ch1 = createMockChannel('ch-1', 'proj-code');
      const ch2 = createMockChannel('ch-2', 'proj-review');
      const ch3 = createMockChannel('ch-3', 'random', true);

      const guild = createMockGuild('g-1', 'TestGuild', [ch1, ch2, ch3]);
      client = createMockClient([guild]);
      channels = new DiscordChannels(client, registry);

      registry.parseChannelName
        .mockReturnValueOnce({ projectName: 'proj', agent: { config: { name: 'coder' } } })
        .mockReturnValueOnce({ projectName: 'proj', agent: { config: { name: 'reviewer' } } })
        .mockReturnValueOnce(null);

      vi.spyOn(console, 'log').mockImplementation(() => {});

      channels.scanExistingChannels();

      const map = channels.getChannelMapping();
      expect(map.size).toBe(2);
      expect(map.get('ch-1')).toEqual({ projectName: 'proj', agentType: 'coder' });
      expect(map.get('ch-2')).toEqual({ projectName: 'proj', agentType: 'reviewer' });
    });

    it('skips non-text channels', () => {
      const ch = createMockChannel('ch-1', 'proj-code', false);
      const guild = createMockGuild('g-1', 'TestGuild', [ch]);
      client = createMockClient([guild]);
      channels = new DiscordChannels(client, registry);

      channels.scanExistingChannels();

      expect(registry.parseChannelName).not.toHaveBeenCalled();
      expect(channels.getChannelMapping().size).toBe(0);
    });
  });

  // ---------- createAgentChannels ----------

  describe('createAgentChannels', () => {
    it('creates new channels when none exist', async () => {
      const guild = createMockGuild('g-1', 'TestGuild', []);
      // Make fetch return a collection-like object with find
      const emptyCollection = { find: vi.fn().mockReturnValue(undefined) };
      guild.channels.fetch.mockResolvedValueOnce(emptyCollection);

      client = createMockClient([guild]);
      channels = new DiscordChannels(client, registry);

      vi.spyOn(console, 'log').mockImplementation(() => {});

      const configs = [
        { name: 'coder', channelSuffix: 'code', displayName: 'Coder' },
        { name: 'reviewer', channelSuffix: 'review', displayName: 'Reviewer' },
      ] as any[];

      const result = await channels.createAgentChannels('g-1', 'myproj', configs);

      expect(guild.channels.create).toHaveBeenCalledTimes(2);
      expect(result).toHaveProperty('coder');
      expect(result).toHaveProperty('reviewer');
    });

    it('reuses an existing channel when the name matches', async () => {
      const existingCh = createMockChannel('existing-id', 'myproj-code');
      const guild = createMockGuild('g-1', 'TestGuild', [existingCh]);
      const collection = {
        find: vi.fn().mockImplementation((predicate: any) => {
          // Simulate checking all channels
          if (predicate(existingCh)) return existingCh;
          return undefined;
        }),
      };
      guild.channels.fetch.mockResolvedValueOnce(collection);

      client = createMockClient([guild]);
      channels = new DiscordChannels(client, registry);

      vi.spyOn(console, 'log').mockImplementation(() => {});

      const configs = [{ name: 'coder', channelSuffix: 'code', displayName: 'Coder' }] as any[];

      const result = await channels.createAgentChannels('g-1', 'myproj', configs);

      expect(guild.channels.create).not.toHaveBeenCalled();
      expect(result.coder).toBe('existing-id');
    });

    it('stores mappings with instanceId when provided', async () => {
      const guild = createMockGuild('g-1', 'TestGuild', []);
      const emptyCollection = { find: vi.fn().mockReturnValue(undefined) };
      guild.channels.fetch.mockResolvedValueOnce(emptyCollection);

      client = createMockClient([guild]);
      channels = new DiscordChannels(client, registry);

      vi.spyOn(console, 'log').mockImplementation(() => {});

      const configs = [{ name: 'coder', channelSuffix: 'code', displayName: 'Coder' }] as any[];

      await channels.createAgentChannels('g-1', 'myproj', configs, undefined, { coder: 'inst-1' });

      const mapping = channels.getChannelMapping();
      const entry = Array.from(mapping.values()).find((v) => v.agentType === 'coder');
      expect(entry?.instanceId).toBe('inst-1');
    });
  });
});
