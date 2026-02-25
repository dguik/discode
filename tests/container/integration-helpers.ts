/**
 * Shared mock factories for container integration tests.
 *
 * These factories are vi.mock-independent and can be imported
 * by any test file that needs container integration mocks.
 */

import { vi } from 'vitest';
import type { IStateManager } from '../../src/types/interfaces.js';
import type { BridgeConfig } from '../../src/types/index.js';

export function createMockConfig(overrides?: Partial<BridgeConfig>): BridgeConfig {
  return {
    discord: { token: 'test-token' },
    tmux: { sessionPrefix: 'agent-' },
    hookServerPort: 19999,
    ...overrides,
  };
}

export function createMockStateManager(): IStateManager & { [k: string]: any } {
  return {
    reload: vi.fn(),
    getProject: vi.fn(),
    setProject: vi.fn(),
    removeProject: vi.fn(),
    listProjects: vi.fn().mockReturnValue([]),
    getGuildId: vi.fn().mockReturnValue('guild-123'),
    setGuildId: vi.fn(),
    getWorkspaceId: vi.fn().mockReturnValue('workspace-123'),
    setWorkspaceId: vi.fn(),
    updateLastActive: vi.fn(),
    findProjectByChannel: vi.fn(),
    getAgentTypeByChannel: vi.fn(),
  };
}

export function createMockMessaging() {
  return {
    platform: 'discord',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    registerChannelMappings: vi.fn(),
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    getGuilds: vi.fn().mockReturnValue([]),
    getChannelMapping: vi.fn().mockReturnValue(new Map()),
    createAgentChannels: vi.fn().mockResolvedValue({ claude: 'ch-123' }),
    deleteChannel: vi.fn(),
    sendApprovalRequest: vi.fn(),
    sendQuestionWithButtons: vi.fn(),
    setTargetChannel: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
}

export function createMockRuntime() {
  return {
    getOrCreateSession: vi.fn().mockReturnValue('agent-test'),
    createWindow: vi.fn(),
    sendKeysToWindow: vi.fn(),
    typeKeysToWindow: vi.fn(),
    sendEnterToWindow: vi.fn(),
    startAgentInWindow: vi.fn(),
    setSessionEnv: vi.fn(),
    windowExists: vi.fn().mockReturnValue(false),
    listWindows: vi.fn(),
    dispose: vi.fn(),
  } as any;
}

export function createMockRegistry() {
  const mockAdapter = {
    config: { name: 'claude', displayName: 'Claude Code', command: 'claude', channelSuffix: 'claude' },
    getStartCommand: vi.fn().mockReturnValue('cd "/test" && claude'),
    matchesChannel: vi.fn(),
    isInstalled: vi.fn().mockReturnValue(true),
    injectContainerPlugins: vi.fn().mockReturnValue(false),
    buildLaunchCommand: vi.fn().mockImplementation((cmd: string, integration?: any) => {
      const pluginDir = integration?.claudePluginDir;
      if (!pluginDir) return cmd;
      if (/--plugin-dir\b/.test(cmd)) return cmd;
      const pattern = /((?:^|&&|;)\s*)claude\b/;
      if (!pattern.test(cmd)) return cmd;
      return cmd.replace(pattern, `$1claude --plugin-dir '${pluginDir}'`);
    }),
    getExtraEnvVars: vi.fn().mockReturnValue({}),
  };
  return {
    get: vi.fn().mockReturnValue(mockAdapter),
    getAll: vi.fn().mockReturnValue([mockAdapter]),
    register: vi.fn(),
    getByChannelSuffix: vi.fn(),
    parseChannelName: vi.fn(),
    _mockAdapter: mockAdapter,
  } as any;
}
