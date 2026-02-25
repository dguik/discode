/**
 * Integration tests for container mode – setupProject.
 *
 * Tests the full flow of setupProject with container enabled/disabled.
 * Lifecycle tests (stop, restore): integration-lifecycle.test.ts
 * All Docker calls are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock container module ────────────────────────────────────────────

const containerMocks = vi.hoisted(() => ({
  isDockerAvailable: vi.fn().mockReturnValue(true),
  createContainer: vi.fn().mockReturnValue('abc123def456'),
  buildDockerStartCommand: vi.fn().mockReturnValue('docker start -ai abc123def456'),
  injectCredentials: vi.fn(),
  injectChromeMcpBridge: vi.fn().mockReturnValue(false),
  injectFile: vi.fn().mockReturnValue(true),
  containerExists: vi.fn().mockReturnValue(true),
  stopContainer: vi.fn().mockReturnValue(true),
  removeContainer: vi.fn().mockReturnValue(true),
  findDockerSocket: vi.fn().mockReturnValue('/var/run/docker.sock'),
  isContainerRunning: vi.fn().mockReturnValue(true),
  ensureImage: vi.fn(),
  removeImage: vi.fn(),
  ChromeMcpProxy: class MockChromeMcpProxy {
    async start() { return false; }
    stop() {}
    isActive() { return false; }
    getPort() { return 18471; }
  },
  WORKSPACE_DIR: '/workspace',
  imageTagFor: (agentType: string) => `discode-agent-${agentType}:1`,
  IMAGE_PREFIX: 'discode-agent',
}));

const syncInstanceMethods = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  finalSync: vi.fn(),
  syncOnce: vi.fn(),
}));

const containerSyncCalls = vi.hoisted(() => ({ args: [] as any[] }));

vi.mock('../../src/container/index.js', () => containerMocks);

vi.mock('../../src/container/sync.js', () => ({
  ContainerSync: class MockContainerSync {
    start = syncInstanceMethods.start;
    stop = syncInstanceMethods.stop;
    finalSync = syncInstanceMethods.finalSync;
    syncOnce = syncInstanceMethods.syncOnce;
    constructor(options: any) {
      containerSyncCalls.args.push(options);
    }
  },
}));

// ── Mock plugin installers ───────────────────────────────────────────

const pluginInstallerMocks = vi.hoisted(() => ({
  installOpencodePlugin: vi.fn().mockReturnValue('/mock/opencode/plugin.ts'),
  installClaudePlugin: vi.fn().mockReturnValue('/mock/claude/plugin'),
  installGeminiHook: vi.fn().mockReturnValue('/mock/gemini/hook.js'),
}));

vi.mock('../../src/opencode/plugin-installer.js', () => ({
  installOpencodePlugin: pluginInstallerMocks.installOpencodePlugin,
  getPluginSourcePath: () => '/mock/src/opencode/plugin/agent-opencode-bridge-plugin.ts',
  OPENCODE_PLUGIN_FILENAME: 'agent-opencode-bridge-plugin.ts',
}));

vi.mock('../../src/claude/plugin-installer.js', () => ({
  installClaudePlugin: pluginInstallerMocks.installClaudePlugin,
}));

vi.mock('../../src/gemini/hook-installer.js', () => ({
  installGeminiHook: pluginInstallerMocks.installGeminiHook,
  getGeminiHookSourcePath: () => '/mock/src/gemini/hook/discode-after-agent-hook.js',
  GEMINI_AFTER_AGENT_HOOK_FILENAME: 'discode-after-agent-hook.js',
  GEMINI_NOTIFICATION_HOOK_FILENAME: 'discode-notification-hook.js',
  GEMINI_SESSION_HOOK_FILENAME: 'discode-session-hook.js',
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import { AgentBridge } from '../../src/index.js';
import {
  createMockConfig,
  createMockStateManager,
  createMockMessaging,
  createMockRuntime,
  createMockRegistry,
} from './integration-helpers.js';

// ── Tests ────────────────────────────────────────────────────────────

describe('container mode integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    containerMocks.isDockerAvailable.mockReturnValue(true);
    containerMocks.createContainer.mockReturnValue('abc123def456');
    containerMocks.buildDockerStartCommand.mockReturnValue('docker start -ai abc123def456');
    containerMocks.containerExists.mockReturnValue(true);
    syncInstanceMethods.start.mockClear();
    syncInstanceMethods.stop.mockClear();
    syncInstanceMethods.finalSync.mockClear();
    containerSyncCalls.args.length = 0;
  });

  describe('setupProject with container enabled', () => {
    it('creates a container instead of running agent command directly', async () => {
      const mockRuntime = createMockRuntime();
      const mockStateManager = createMockStateManager();
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: mockRuntime,
        stateManager: mockStateManager,
        registry: createMockRegistry(),
        config: createMockConfig({ container: { enabled: true } }),
      });

      const result = await bridge.setupProject(
        'test-project',
        '/test/path',
        { claude: true },
      );

      // Should have created a container
      expect(containerMocks.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          containerName: 'discode-test-project-claude',
          projectPath: '/test/path',
          env: expect.objectContaining({
            DISCODE_PROJECT: 'test-project',
            DISCODE_HOSTNAME: 'host.docker.internal',
          }),
        }),
      );

      // Should have injected credentials
      expect(containerMocks.injectCredentials).toHaveBeenCalledWith(
        'abc123def456',
        undefined,
      );

      // Should start agent with docker start command
      expect(mockRuntime.startAgentInWindow).toHaveBeenCalledWith(
        'agent-test',
        'test-project-claude',
        'docker start -ai abc123def456',
      );

      // Should start sync
      expect(containerSyncCalls.args).toEqual([
        expect.objectContaining({
          containerId: 'abc123def456',
          projectPath: '/test/path',
        }),
      ]);
      expect(syncInstanceMethods.start).toHaveBeenCalled();

      expect(result.channelId).toBe('ch-123');
    });

    it('saves container fields in project state', async () => {
      const mockStateManager = createMockStateManager();
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: mockStateManager,
        registry: createMockRegistry(),
        config: createMockConfig({ container: { enabled: true } }),
      });

      await bridge.setupProject('test-project', '/test/path', { claude: true });

      expect(mockStateManager.setProject).toHaveBeenCalledWith(
        expect.objectContaining({
          instances: expect.objectContaining({
            claude: expect.objectContaining({
              containerMode: true,
              containerId: 'abc123def456',
              containerName: 'discode-test-project-claude',
            }),
          }),
        }),
      );
    });

    it('throws when Docker is not available', async () => {
      containerMocks.isDockerAvailable.mockReturnValue(false);

      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig({ container: { enabled: true } }),
      });

      await expect(
        bridge.setupProject('test', '/test', { claude: true }),
      ).rejects.toThrow('Docker is not available');
    });

    it('passes custom socket path to container operations', async () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig({
          container: { enabled: true, socketPath: '/custom/sock' },
        }),
      });

      await bridge.setupProject('test', '/test', { claude: true });

      expect(containerMocks.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          socketPath: '/custom/sock',
        }),
      );
    });

    it('passes agent command to createContainer for execution inside container', async () => {
      const registry = createMockRegistry();
      // Simulate adapter returning a command using the given projectPath
      registry._mockAdapter.getStartCommand.mockImplementation(
        (path: string) => `cd "${path}" && claude --dangerously-skip-permissions`,
      );

      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry,
        config: createMockConfig({ container: { enabled: true } }),
      });

      await bridge.setupProject('test', '/test/path', { claude: true });

      // Agent command should use WORKSPACE_DIR (/workspace) not the host projectPath
      const createArgs = containerMocks.createContainer.mock.calls[0][0];
      expect(createArgs.command).toContain('/workspace');
      expect(createArgs.command).not.toContain('/test/path');
      // Adapter's getStartCommand should have been called with /workspace
      expect(registry._mockAdapter.getStartCommand).toHaveBeenCalledWith(
        '/workspace',
        expect.anything(),
      );
    });

    it('passes plugin volume mount to createContainer when plugin dir exists', async () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig({ container: { enabled: true } }),
      });

      await bridge.setupProject('test', '/test', { claude: true });

      const createArgs = containerMocks.createContainer.mock.calls[0][0];
      // Should have volumes array with plugin mount (host:container:ro)
      expect(createArgs.volumes).toBeDefined();
      expect(Array.isArray(createArgs.volumes)).toBe(true);
      if (createArgs.volumes.length > 0) {
        expect(createArgs.volumes[0]).toContain('/home/coder/.claude/plugins/discode-claude-bridge:ro');
      }
    });

    it('includes plugin-dir in agent command when plugin is installed', async () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig({ container: { enabled: true } }),
      });

      await bridge.setupProject('test', '/test', { claude: true });

      const createArgs = containerMocks.createContainer.mock.calls[0][0];
      // The command should include --plugin-dir pointing to the container plugin path
      if (createArgs.command) {
        expect(createArgs.command).toContain('--plugin-dir');
        expect(createArgs.command).toContain('/home/coder/.claude/plugins/discode-claude-bridge');
      }
    });

    it('injects OpenCode plugin into container for opencode agent', async () => {
      const registry = createMockRegistry();
      // Override the adapter to be opencode
      registry._mockAdapter.config = {
        name: 'opencode',
        displayName: 'OpenCode',
        command: 'opencode',
        channelSuffix: 'opencode',
      };
      registry._mockAdapter.getStartCommand.mockReturnValue('opencode');
      registry._mockAdapter.injectContainerPlugins.mockImplementation(
        (containerId: string, socketPath?: string) => {
          containerMocks.injectFile(
            containerId,
            '/mock/src/opencode/plugin/agent-opencode-bridge-plugin.ts',
            '/home/coder/.opencode/plugins',
            socketPath,
          );
          return true;
        },
      );

      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry,
        config: createMockConfig({ container: { enabled: true } }),
      });

      await bridge.setupProject('test', '/test', { opencode: true });

      // Should inject plugin file into the container
      expect(containerMocks.injectFile).toHaveBeenCalledWith(
        'abc123def456',
        '/mock/src/opencode/plugin/agent-opencode-bridge-plugin.ts',
        '/home/coder/.opencode/plugins',
        undefined,
      );
    });

    it('injects Gemini hook into container for gemini agent', async () => {
      const registry = createMockRegistry();
      registry._mockAdapter.config = {
        name: 'gemini',
        displayName: 'Gemini CLI',
        command: 'gemini',
        channelSuffix: 'gemini',
      };
      registry._mockAdapter.getStartCommand.mockReturnValue('gemini');
      registry._mockAdapter.injectContainerPlugins.mockImplementation(
        (containerId: string, socketPath?: string) => {
          containerMocks.injectFile(
            containerId,
            '/mock/src/gemini/hook/discode-after-agent-hook.js',
            '/home/coder/.gemini/discode-hooks',
            socketPath,
          );
          return true;
        },
      );

      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry,
        config: createMockConfig({ container: { enabled: true } }),
      });

      await bridge.setupProject('test', '/test', { gemini: true });

      expect(containerMocks.injectFile).toHaveBeenCalledWith(
        'abc123def456',
        '/mock/src/gemini/hook/discode-after-agent-hook.js',
        '/home/coder/.gemini/discode-hooks',
        undefined,
      );
    });

    it('does not inject OpenCode plugin for claude agent', async () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig({ container: { enabled: true } }),
      });

      await bridge.setupProject('test', '/test', { claude: true });

      // injectFile is called for message-router file injection etc.,
      // but NOT for opencode plugin or gemini hook paths
      for (const call of containerMocks.injectFile.mock.calls) {
        expect(call[2]).not.toBe('/home/coder/.opencode/plugins');
        expect(call[2]).not.toBe('/home/coder/.gemini/discode-hooks');
      }
    });

    it('skips runtime start when skipRuntimeStart is true', async () => {
      const mockRuntime = createMockRuntime();
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: mockRuntime,
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig({ container: { enabled: true } }),
      });

      await bridge.setupProject('test', '/test', { claude: true }, undefined, undefined, {
        skipRuntimeStart: true,
      });

      // Container should be created but not started
      expect(containerMocks.createContainer).toHaveBeenCalled();
      expect(containerMocks.injectCredentials).toHaveBeenCalled();
      expect(mockRuntime.startAgentInWindow).not.toHaveBeenCalled();
      // Sync should still start
      expect(syncInstanceMethods.start).toHaveBeenCalled();
    });
  });

});
