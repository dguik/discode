/**
 * Unit tests for channel-service module.
 *
 * Covers:
 * - deleteChannels: deduplication, empty input, partial success, disconnect guarantee
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockDeleteChannel = vi.fn().mockResolvedValue(true);

vi.mock('../../src/config/index.js', () => ({
  config: {
    messagingPlatform: 'slack',
    slack: { botToken: 'xoxb-test', appToken: 'xapp-test' },
    discord: { token: 'discord-test' },
  },
  validateConfig: vi.fn(),
}));

vi.mock('../../src/slack/client.js', () => {
  return {
    SlackClient: class MockSlackClient {
      connect = mockConnect;
      disconnect = mockDisconnect;
      deleteChannel = mockDeleteChannel;
    },
  };
});

vi.mock('../../src/discord/client.js', () => {
  return {
    DiscordClient: class MockDiscordClient {
      connect = mockConnect;
      disconnect = mockDisconnect;
      deleteChannel = mockDeleteChannel;
    },
  };
});

// ── Import after mocks ──────────────────────────────────────────────

import { deleteChannels } from '../../src/app/channel-service.js';

// ── Tests ────────────────────────────────────────────────────────────

describe('deleteChannels', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array for empty input', async () => {
    const result = await deleteChannels([]);
    expect(result).toEqual([]);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('filters out falsy channel IDs', async () => {
    const result = await deleteChannels(['', '', '']);
    expect(result).toEqual([]);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('deduplicates channel IDs', async () => {
    await deleteChannels(['ch-1', 'ch-1', 'ch-2']);
    expect(mockDeleteChannel).toHaveBeenCalledTimes(2);
    expect(mockDeleteChannel).toHaveBeenCalledWith('ch-1');
    expect(mockDeleteChannel).toHaveBeenCalledWith('ch-2');
  });

  it('connects before deleting and disconnects after', async () => {
    const callOrder: string[] = [];
    mockConnect.mockImplementation(() => { callOrder.push('connect'); return Promise.resolve(); });
    mockDeleteChannel.mockImplementation(() => { callOrder.push('delete'); return Promise.resolve(true); });
    mockDisconnect.mockImplementation(() => { callOrder.push('disconnect'); return Promise.resolve(); });

    await deleteChannels(['ch-1']);

    expect(callOrder).toEqual(['connect', 'delete', 'disconnect']);
  });

  it('returns only successfully deleted channels', async () => {
    mockDeleteChannel
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const result = await deleteChannels(['ch-1', 'ch-2', 'ch-3']);
    expect(result).toEqual(['ch-1', 'ch-3']);
  });

  it('disconnects even when delete throws', async () => {
    mockDeleteChannel.mockRejectedValueOnce(new Error('API error'));

    await expect(deleteChannels(['ch-1'])).rejects.toThrow('API error');
    expect(mockDisconnect).toHaveBeenCalled();
  });
});
