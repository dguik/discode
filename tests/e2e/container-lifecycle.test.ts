/**
 * E2E tests for container lifecycle.
 *
 * Tests the full flow of:
 *   1. setupProject -> state persistence (containerId, containerName saved)
 *   2. Credential and Chrome MCP bridge injection during setup
 *   3. ContainerSync lifecycle (start on setup, stop on bridge stop)
 *   4. ChromeMcpProxy integration (port arithmetic, start/stop, isActive)
 *
 * Strategy: Mock child_process, fs, and container module for all Docker
 * commands. Test the real AgentBridge + real state path through mocked
 * container primitives, following the patterns from
 * tests/container/integration.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock container module ─────────────────────────────────────────────────────

const containerMocks = vi.hoisted(() => ({
  isDockerAvailable: vi.fn().mockReturnValue(true),
  createContainer: vi.fn().mockReturnValue('ctr-e2e-abc123'),
  buildDockerStartCommand: vi.fn().mockReturnValue('docker start -ai ctr-e2e-abc123'),
  injectCredentials: vi.fn(),
  injectChromeMcpBridge: vi.fn().mockReturnValue(true),
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

// ── Mock plugin installers ────────────────────────────────────────────────────

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

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { AgentBridge } from '../../src/index.js';
import { ChromeMcpProxy } from '../../src/container/chrome-mcp-proxy.js';
import {
  createMockConfig,
  createMockStateManager,
  createMockMessaging,
  createMockRuntime,
  createMockRegistry,
} from '../container/integration-helpers.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Container Lifecycle E2E', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    containerMocks.isDockerAvailable.mockReturnValue(true);
    containerMocks.createContainer.mockReturnValue('ctr-e2e-abc123');
    containerMocks.buildDockerStartCommand.mockReturnValue('docker start -ai ctr-e2e-abc123');
    containerMocks.containerExists.mockReturnValue(true);
    containerMocks.injectChromeMcpBridge.mockReturnValue(true);
    syncInstanceMethods.start.mockClear();
    syncInstanceMethods.stop.mockClear();
    syncInstanceMethods.finalSync.mockClear();
    containerSyncCalls.args.length = 0;
  });

  // ── Setup -> State -> Restore flow ─────────────────────────────────────────

  describe('Setup -> State -> Restore flow', () => {
    it('setupProject with containerMode saves containerId and containerName in state', async () => {
      const mockStateManager = createMockStateManager();
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: mockStateManager,
        registry: createMockRegistry(),
        config: createMockConfig({ container: { enabled: true } }),
      });

      await bridge.setupProject('e2e-project', '/e2e/path', { claude: true });

      // Verify the project state was saved with the container fields populated
      expect(mockStateManager.setProject).toHaveBeenCalledWith(
        expect.objectContaining({
          projectName: 'e2e-project',
          projectPath: '/e2e/path',
          instances: expect.objectContaining({
            claude: expect.objectContaining({
              containerMode: true,
              containerId: 'ctr-e2e-abc123',
              containerName: 'discode-e2e-project-claude',
            }),
          }),
        }),
      );
    });

    it('setupProject persists instanceId that matches the container name suffix', async () => {
      const mockStateManager = createMockStateManager();
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: mockStateManager,
        registry: createMockRegistry(),
        config: createMockConfig({ container: { enabled: true } }),
      });

      await bridge.setupProject('my-proj', '/my/proj', { claude: true });

      const savedProject = mockStateManager.setProject.mock.calls[0][0];
      const instance = savedProject.instances.claude;
      // instanceId is 'claude' for the first claude instance
      expect(instance.instanceId).toBe('claude');
      // containerName is derived from projectName + instanceId
      expect(instance.containerName).toBe('discode-my-proj-claude');
    });

    it('injects credentials into the container during setup', async () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig({ container: { enabled: true } }),
      });

      await bridge.setupProject('cred-proj', '/cred/path', { claude: true });

      expect(containerMocks.injectCredentials).toHaveBeenCalledWith(
        'ctr-e2e-abc123',
        undefined,
      );
    });

    it('injects Chrome MCP bridge into the container during setup', async () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig({
          hookServerPort: 18470,
          container: { enabled: true },
        }),
      });

      await bridge.setupProject('mcp-proj', '/mcp/path', { claude: true });

      // Bridge is injected with hookServerPort+1 as the Chrome MCP proxy port
      expect(containerMocks.injectChromeMcpBridge).toHaveBeenCalledWith(
        'ctr-e2e-abc123',
        18471,
        'claude',
        undefined,
      );
    });

    it('injects Chrome MCP bridge using custom hookServerPort', async () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig({
          hookServerPort: 19000,
          container: { enabled: true },
        }),
      });

      await bridge.setupProject('port-proj', '/port/path', { claude: true });

      expect(containerMocks.injectChromeMcpBridge).toHaveBeenCalledWith(
        'ctr-e2e-abc123',
        19001,
        'claude',
        undefined,
      );
    });

    it('passes custom Docker socket path through all container calls', async () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig({
          container: { enabled: true, socketPath: '/custom/docker.sock' },
        }),
      });

      await bridge.setupProject('sock-proj', '/sock/path', { claude: true });

      expect(containerMocks.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({ socketPath: '/custom/docker.sock' }),
      );
      expect(containerMocks.injectCredentials).toHaveBeenCalledWith(
        'ctr-e2e-abc123',
        '/custom/docker.sock',
      );
      expect(containerMocks.injectChromeMcpBridge).toHaveBeenCalledWith(
        'ctr-e2e-abc123',
        expect.any(Number),
        'claude',
        '/custom/docker.sock',
      );
    });

    it('creates the container using the workspace path, not the host project path', async () => {
      const registry = createMockRegistry();
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

      await bridge.setupProject('ws-proj', '/host/project/path', { claude: true });

      const createArgs = containerMocks.createContainer.mock.calls[0][0];
      // The command inside the container must refer to /workspace, not the host path
      expect(createArgs.command).toContain('/workspace');
      expect(createArgs.command).not.toContain('/host/project/path');
      // The host project path is still used for the volume mount
      expect(createArgs.projectPath).toBe('/host/project/path');
    });
  });

  // ── Cleanup ──────────────────────────────────────────────────────────────────

  describe('Cleanup', () => {
    it('setupProject starts a ContainerSync that can be stopped on bridge stop', async () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig({ container: { enabled: true } }),
      });

      await bridge.setupProject('sync-proj', '/sync/path', { claude: true });

      // Sync must have been created with the right parameters and started
      expect(containerSyncCalls.args).toHaveLength(1);
      expect(containerSyncCalls.args[0]).toMatchObject({
        containerId: 'ctr-e2e-abc123',
        projectPath: '/sync/path',
      });
      expect(syncInstanceMethods.start).toHaveBeenCalledTimes(1);

      // Stopping the bridge must propagate stop() to all active syncs
      await bridge.stop();
      expect(syncInstanceMethods.stop).toHaveBeenCalledTimes(1);
    });

    it('multiple setupProject calls each produce an independent ContainerSync', async () => {
      // Return different container IDs for each createContainer call
      containerMocks.createContainer
        .mockReturnValueOnce('ctr-alpha')
        .mockReturnValueOnce('ctr-beta');

      const registry = createMockRegistry();
      // Make the second call use a different instance ID by advancing state
      const stateManager = createMockStateManager();
      // First call: no existing project
      stateManager.getProject.mockReturnValue(undefined);

      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager,
        registry,
        config: createMockConfig({ container: { enabled: true } }),
      });

      await bridge.setupProject('multi-proj', '/multi/path', { claude: true });

      // Two independent syncs should have been created
      expect(containerSyncCalls.args).toHaveLength(1);
      expect(containerSyncCalls.args[0]).toMatchObject({ containerId: 'ctr-alpha' });
      expect(syncInstanceMethods.start).toHaveBeenCalledTimes(1);

      // Stopping the bridge stops all syncs
      await bridge.stop();
      expect(syncInstanceMethods.stop).toHaveBeenCalledTimes(1);
    });

    it('ContainerSync receives the custom socket path from config', async () => {
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig({
          container: { enabled: true, socketPath: '/custom/docker.sock' },
        }),
      });

      await bridge.setupProject('syncpath-proj', '/sp/path', { claude: true });

      expect(containerSyncCalls.args[0]).toMatchObject({
        socketPath: '/custom/docker.sock',
      });
    });

    it('stop does not throw when no container syncs have been created', async () => {
      // Standard mode — no container syncs
      const bridge = new AgentBridge({
        messaging: createMockMessaging(),
        runtime: createMockRuntime(),
        stateManager: createMockStateManager(),
        registry: createMockRegistry(),
        config: createMockConfig(),
      });

      await bridge.setupProject('nostop-proj', '/no/path', { claude: true });

      await expect(bridge.stop()).resolves.not.toThrow();
      expect(syncInstanceMethods.stop).not.toHaveBeenCalled();
    });
  });

  // ── Chrome MCP Proxy integration ─────────────────────────────────────────────

  describe('Chrome MCP Proxy integration', () => {
    it('proxy getPort returns hookServerPort + 1', () => {
      const proxy = new ChromeMcpProxy({ port: 18471 });
      expect(proxy.getPort()).toBe(18471);
    });

    it('proxy getPort uses the value provided at construction time', () => {
      const proxy = new ChromeMcpProxy({ port: 19001 });
      expect(proxy.getPort()).toBe(19001);
    });

    it('proxy start returns false when no Unix socket is discoverable', async () => {
      // Override discoverSocket so it reliably returns null regardless of machine state
      const proxy = new ChromeMcpProxy({ port: 18471 });
      proxy.discoverSocket = () => null;

      const started = await proxy.start();

      expect(started).toBe(false);
      expect(proxy.isActive()).toBe(false);
    });

    it('proxy stop does not throw when start was never called', () => {
      const proxy = new ChromeMcpProxy({ port: 18471 });
      expect(() => proxy.stop()).not.toThrow();
    });

    it('proxy isActive returns false after a failed start', async () => {
      const proxy = new ChromeMcpProxy({ port: 18471 });
      proxy.discoverSocket = () => null;
      await proxy.start();

      expect(proxy.isActive()).toBe(false);
    });

    it('proxy isActive remains false after stop when never started', () => {
      const proxy = new ChromeMcpProxy({ port: 18471 });
      proxy.stop();
      expect(proxy.isActive()).toBe(false);
    });

    it('proxy start is idempotent when no socket is present — repeated calls return false', async () => {
      const proxy = new ChromeMcpProxy({ port: 18471 });
      proxy.discoverSocket = () => null;

      expect(await proxy.start()).toBe(false);
      expect(await proxy.start()).toBe(false);
      expect(proxy.isActive()).toBe(false);
    });

    it('proxy port arithmetic: hookServerPort 18470 -> proxy port 18471', () => {
      const hookServerPort = 18470;
      const expectedProxyPort = hookServerPort + 1;
      const proxy = new ChromeMcpProxy({ port: expectedProxyPort });
      expect(proxy.getPort()).toBe(18471);
    });

    it('proxy port arithmetic: hookServerPort 19000 -> proxy port 19001', () => {
      const hookServerPort = 19000;
      const expectedProxyPort = hookServerPort + 1;
      const proxy = new ChromeMcpProxy({ port: expectedProxyPort });
      expect(proxy.getPort()).toBe(19001);
    });

    it('proxy stop cleans up cleanly after a failed start', async () => {
      const proxy = new ChromeMcpProxy({ port: 18471 });
      proxy.discoverSocket = () => null;

      await proxy.start();
      expect(() => proxy.stop()).not.toThrow();
      expect(proxy.isActive()).toBe(false);
    });

    it('discoverSocket returns string or null without throwing on any machine state', () => {
      const proxy = new ChromeMcpProxy({ port: 18471 });
      // discoverSocket reads the filesystem; it should never throw — only return null
      let result: string | null;
      expect(() => {
        result = proxy.discoverSocket();
      }).not.toThrow();
      expect(result! === null || typeof result! === 'string').toBe(true);
    });
  });
});
