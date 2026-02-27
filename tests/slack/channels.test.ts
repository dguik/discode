import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SlackChannels } from '../../src/slack/channels.js';

function createMockApp() {
  return {
    client: {
      conversations: {
        list: vi.fn().mockResolvedValue({ channels: [], response_metadata: {} }),
        create: vi.fn().mockResolvedValue({ channel: { id: 'C001' } }),
        join: vi.fn().mockResolvedValue(undefined),
        setTopic: vi.fn().mockResolvedValue(undefined),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue(undefined),
      },
      auth: {
        test: vi.fn().mockResolvedValue({ team_id: 'T001', team: 'TestTeam' }),
      },
    },
  } as any;
}

describe('SlackChannels', () => {
  let app: ReturnType<typeof createMockApp>;
  let channels: SlackChannels;
  const token = 'xoxb-test-token';

  beforeEach(() => {
    app = createMockApp();
    channels = new SlackChannels(app, token);
  });

  describe('getChannelMapping', () => {
    it('returns an empty map initially', () => {
      const mapping = channels.getChannelMapping();
      expect(mapping).toBeInstanceOf(Map);
      expect(mapping.size).toBe(0);
    });

    it('returns a copy, not the internal map', () => {
      channels.setChannelInfo('C001', { projectName: 'proj', agentType: 'claude' });

      const copy = channels.getChannelMapping();
      copy.delete('C001');

      // Internal map should be unaffected
      expect(channels.getChannelInfo('C001')).toEqual({ projectName: 'proj', agentType: 'claude' });
    });
  });

  describe('getChannelInfo / setChannelInfo', () => {
    it('returns undefined for unknown channel', () => {
      expect(channels.getChannelInfo('C_UNKNOWN')).toBeUndefined();
    });

    it('stores and retrieves channel info', () => {
      const info = { projectName: 'myproj', agentType: 'opencode', instanceId: 'inst1' };
      channels.setChannelInfo('C002', info);

      expect(channels.getChannelInfo('C002')).toEqual(info);
    });
  });

  describe('getGuilds', () => {
    it('returns an empty array initially', () => {
      expect(channels.getGuilds()).toEqual([]);
    });

    it('returns workspaces after scanExistingChannels', async () => {
      await channels.scanExistingChannels();

      expect(channels.getGuilds()).toEqual([{ id: 'T001', name: 'TestTeam' }]);
    });
  });

  describe('deleteChannel', () => {
    it('removes the channel from the mapping and returns true', async () => {
      channels.setChannelInfo('C001', { projectName: 'proj', agentType: 'claude' });

      const result = await channels.deleteChannel('C001');

      expect(result).toBe(true);
      expect(channels.getChannelInfo('C001')).toBeUndefined();
    });

    it('returns true even if channel did not exist', async () => {
      const result = await channels.deleteChannel('C_NONEXISTENT');
      expect(result).toBe(true);
    });
  });

  describe('registerChannelMappings', () => {
    it('populates the channel mapping', () => {
      channels.registerChannelMappings([
        { channelId: 'C001', projectName: 'proj', agentType: 'claude' },
        { channelId: 'C002', projectName: 'proj', agentType: 'opencode', instanceId: 'inst1' },
      ]);

      expect(channels.getChannelInfo('C001')).toEqual({
        projectName: 'proj',
        agentType: 'claude',
        instanceId: undefined,
      });
      expect(channels.getChannelInfo('C002')).toEqual({
        projectName: 'proj',
        agentType: 'opencode',
        instanceId: 'inst1',
      });
    });

    it('sets lastSeenTs for newly registered channels', () => {
      channels.registerChannelMappings([
        { channelId: 'C001', projectName: 'proj', agentType: 'claude' },
      ]);

      expect(channels.lastSeenTs.has('C001')).toBe(true);
      // Timestamp should look like "<seconds>.000000"
      const ts = channels.lastSeenTs.get('C001')!;
      expect(ts).toMatch(/^\d+\.000000$/);
    });

    it('does not overwrite an existing lastSeenTs value', () => {
      channels.lastSeenTs.set('C001', '999.000');

      channels.registerChannelMappings([
        { channelId: 'C001', projectName: 'proj', agentType: 'claude' },
      ]);

      expect(channels.lastSeenTs.get('C001')).toBe('999.000');
    });
  });

  describe('createAgentChannels', () => {
    const agentConfigs = [
      { name: 'claude', displayName: 'Claude', command: 'claude', channelSuffix: 'claude' },
    ];

    it('creates a new channel when none exists', async () => {
      const result = await channels.createAgentChannels('T001', 'myproj', agentConfigs);

      expect(app.client.conversations.list).toHaveBeenCalled();
      expect(app.client.conversations.create).toHaveBeenCalledWith({
        token,
        name: 'myproj-claude',
      });
      expect(app.client.conversations.setTopic).toHaveBeenCalledWith({
        token,
        channel: 'C001',
        topic: 'Claude agent for myproj',
      });
      expect(result).toEqual({ claude: 'C001' });
    });

    it('reuses an existing channel found by name', async () => {
      app.client.conversations.list.mockResolvedValueOnce({
        channels: [{ name: 'myproj-claude', id: 'C_EXISTING' }],
        response_metadata: {},
      });

      const result = await channels.createAgentChannels('T001', 'myproj', agentConfigs);

      expect(app.client.conversations.create).not.toHaveBeenCalled();
      expect(app.client.conversations.join).toHaveBeenCalledWith({
        token,
        channel: 'C_EXISTING',
      });
      expect(result).toEqual({ claude: 'C_EXISTING' });
    });

    it('paginates through conversation lists', async () => {
      // First page has a cursor, second page has the channel
      app.client.conversations.list
        .mockResolvedValueOnce({
          channels: [],
          response_metadata: { next_cursor: 'cursor_page2' },
        })
        .mockResolvedValueOnce({
          channels: [{ name: 'myproj-claude', id: 'C_PAGE2' }],
          response_metadata: {},
        });

      const result = await channels.createAgentChannels('T001', 'myproj', agentConfigs);

      expect(app.client.conversations.list).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ claude: 'C_PAGE2' });
    });

    it('uses customChannelName when provided', async () => {
      const result = await channels.createAgentChannels(
        'T001',
        'myproj',
        agentConfigs,
        'custom-channel',
      );

      expect(app.client.conversations.create).toHaveBeenCalledWith({
        token,
        name: 'custom-channel',
      });
      expect(result).toEqual({ claude: 'C001' });
    });

    it('normalizes channel names (lowercase, replace spaces, strip invalid chars)', async () => {
      const result = await channels.createAgentChannels(
        'T001',
        'My Project!',
        agentConfigs,
      );

      expect(app.client.conversations.create).toHaveBeenCalledWith({
        token,
        name: 'my-project-claude',
      });
      expect(result).toEqual({ claude: 'C001' });
    });

    it('stores the channel in the internal mapping', async () => {
      await channels.createAgentChannels('T001', 'myproj', agentConfigs);

      expect(channels.getChannelInfo('C001')).toEqual({
        projectName: 'myproj',
        agentType: 'claude',
        instanceId: undefined,
      });
    });

    it('handles name_taken error by searching for the channel', async () => {
      const nameTakenError = new Error('name_taken');
      (nameTakenError as any).data = { error: 'name_taken' };
      app.client.conversations.create.mockRejectedValueOnce(nameTakenError);

      // findChannelByName will call conversations.list again
      app.client.conversations.list
        .mockResolvedValueOnce({ channels: [], response_metadata: {} }) // initial scan
        .mockResolvedValueOnce({
          channels: [{ name: 'myproj-claude', id: 'C_FOUND' }],
          response_metadata: {},
        }); // findChannelByName

      const result = await channels.createAgentChannels('T001', 'myproj', agentConfigs);

      expect(result).toEqual({ claude: 'C_FOUND' });
    });
  });

  describe('scanExistingChannels', () => {
    it('calls auth.test and conversations.list', async () => {
      await channels.scanExistingChannels();

      expect(app.client.auth.test).toHaveBeenCalledWith({ token });
      expect(app.client.conversations.list).toHaveBeenCalledWith({
        token,
        types: 'public_channel,private_channel',
        limit: 1000,
      });
    });

    it('populates workspaces from auth.test', async () => {
      await channels.scanExistingChannels();

      expect(channels.getGuilds()).toEqual([{ id: 'T001', name: 'TestTeam' }]);
    });

    it('does not throw when the API fails', async () => {
      app.client.auth.test.mockRejectedValueOnce(new Error('auth failed'));

      await expect(channels.scanExistingChannels()).resolves.toBeUndefined();
    });
  });
});
