import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { RuntimeRoutesDeps } from '../../src/bridge/hook-runtime-routes.js';
import { HookRuntimeRoutes } from '../../src/bridge/hook-runtime-routes.js';
import type { AgentRuntime } from '../../src/runtime/interface.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  realpathSync: vi.fn((p: string) => p),
}));

vi.mock('../../src/state/instances.js', () => ({
  normalizeProjectState: vi.fn((p: any) => p),
  getProjectInstance: vi.fn(),
  getPrimaryInstanceForAgent: vi.fn(),
  listProjectInstances: vi.fn(() => []),
}));

vi.mock('../../src/agents/index.js', () => ({
  agentRegistry: { get: vi.fn() },
}));

vi.mock('../../src/policy/agent-integration.js', () => ({
  installAgentIntegration: vi.fn(() => ({
    agentType: 'opencode', eventHookInstalled: true, infoMessages: [], warningMessages: [],
  })),
}));

vi.mock('../../src/policy/agent-launch.js', () => ({
  buildAgentLaunchEnv: vi.fn(() => ({ DISCODE_PORT: '18470' })),
  buildExportPrefix: vi.fn(() => 'export DISCODE_PORT=18470; '),
  readHookToken: () => 'mock-hook-token',
}));

// Lazy imports so the mocks are wired before the module loads
import { existsSync, realpathSync } from 'fs';
import {
  normalizeProjectState,
  getProjectInstance,
  getPrimaryInstanceForAgent,
  listProjectInstances,
} from '../../src/state/instances.js';
import { agentRegistry } from '../../src/agents/index.js';
import { installAgentIntegration } from '../../src/policy/agent-integration.js';
import { buildAgentLaunchEnv, buildExportPrefix } from '../../src/policy/agent-launch.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockMessaging() {
  return {
    platform: 'discord' as const,
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    sendToChannelWithId: vi.fn().mockResolvedValue('msg-id'),
    sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    replyInThread: vi.fn().mockResolvedValue(undefined),
    replyInThreadWithId: vi.fn().mockResolvedValue('reply-id'),
    updateMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockStateManager() {
  return {
    reload: vi.fn(),
    getProject: vi.fn(),
    setProject: vi.fn(),
    removeProject: vi.fn(),
    listProjects: vi.fn().mockReturnValue([]),
    getGuildId: vi.fn(),
    setGuildId: vi.fn(),
    getWorkspaceId: vi.fn(),
    setWorkspaceId: vi.fn(),
  } as any;
}

function createDeps(overrides: Partial<RuntimeRoutesDeps> = {}): RuntimeRoutesDeps {
  return {
    port: 18470,
    messaging: createMockMessaging(),
    stateManager: createMockStateManager(),
    runtime: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HookRuntimeRoutes — handleSendFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

    it('returns 400 when payload is null', async () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = await routes.handleSendFiles(null);

      expect(result).toEqual({ status: 400, message: 'Invalid payload' });
    });

    it('returns 400 when payload is not an object', async () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = await routes.handleSendFiles('bad');

      expect(result).toEqual({ status: 400, message: 'Invalid payload' });
    });

    it('returns 400 when projectName is missing', async () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = await routes.handleSendFiles({ files: ['/tmp/a.txt'] });

      expect(result).toEqual({ status: 400, message: 'Missing projectName' });
    });

    it('returns 400 when files array is empty', async () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = await routes.handleSendFiles({ projectName: 'proj', files: [] });

      expect(result).toEqual({ status: 400, message: 'No files provided' });
    });

    it('returns 400 when files is not an array', async () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = await routes.handleSendFiles({ projectName: 'proj', files: 'not-array' });

      expect(result).toEqual({ status: 400, message: 'No files provided' });
    });

    it('returns 404 when project is not found', async () => {
      const deps = createDeps();
      (deps.stateManager.getProject as any).mockReturnValue(undefined);
      const routes = new HookRuntimeRoutes(deps);

      const result = await routes.handleSendFiles({
        projectName: 'unknown',
        files: ['/tmp/a.txt'],
      });

      expect(result).toEqual({ status: 404, message: 'Project not found' });
    });

    it('returns 404 when no channel found for project/agent', async () => {
      const project = { name: 'proj', projectPath: '/tmp/proj' };
      const deps = createDeps();
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (getPrimaryInstanceForAgent as any).mockReturnValue(undefined);
      const routes = new HookRuntimeRoutes(deps);

      const result = await routes.handleSendFiles({
        projectName: 'proj',
        files: ['/tmp/a.txt'],
      });

      expect(result).toEqual({ status: 404, message: 'No channel found for project/agent' });
    });

    it('returns 400 when no valid files after validation', async () => {
      const instance = { instanceId: 'opencode', agentType: 'opencode', channelId: 'ch-1' };
      const project = { name: 'proj', projectPath: '/tmp/proj' };
      const deps = createDeps();
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (getPrimaryInstanceForAgent as any).mockReturnValue(instance);
      // existsSync returns false by default so no files pass validation
      const routes = new HookRuntimeRoutes(deps);

      const result = await routes.handleSendFiles({
        projectName: 'proj',
        files: ['/tmp/proj/test.txt'],
      });

      expect(result).toEqual({ status: 400, message: 'No valid files' });
    });

    it('returns 200 and sends files when all valid', async () => {
      const instance = { instanceId: 'opencode', agentType: 'opencode', channelId: 'ch-1' };
      const project = { name: 'proj', projectPath: '/tmp/proj' };
      const deps = createDeps();
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (getPrimaryInstanceForAgent as any).mockReturnValue(instance);

      (existsSync as any).mockReturnValue(true);
      (realpathSync as any).mockImplementation((p: string) => p);

      const routes = new HookRuntimeRoutes(deps);

      const result = await routes.handleSendFiles({
        projectName: 'proj',
        files: ['/tmp/proj/file.txt'],
      });

      expect(result).toEqual({ status: 200, message: 'OK' });
      expect(deps.messaging.sendToChannelWithFiles).toHaveBeenCalledWith(
        'ch-1',
        '',
        ['/tmp/proj/file.txt'],
      );
    });

    it('filters out files that do not exist', async () => {
      const instance = { instanceId: 'opencode', agentType: 'opencode', channelId: 'ch-1' };
      const project = { name: 'proj', projectPath: '/tmp/proj' };
      const deps = createDeps();
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (getPrimaryInstanceForAgent as any).mockReturnValue(instance);

      (existsSync as any).mockImplementation((p: string) => p === '/tmp/proj/exists.txt');
      (realpathSync as any).mockImplementation((p: string) => p);

      const routes = new HookRuntimeRoutes(deps);

      const result = await routes.handleSendFiles({
        projectName: 'proj',
        files: ['/tmp/proj/exists.txt', '/tmp/proj/missing.txt'],
      });

      expect(result).toEqual({ status: 200, message: 'OK' });
      expect(deps.messaging.sendToChannelWithFiles).toHaveBeenCalledWith(
        'ch-1',
        '',
        ['/tmp/proj/exists.txt'],
      );
    });

    it('rejects files outside the project path (symlink escape)', async () => {
      const instance = { instanceId: 'opencode', agentType: 'opencode', channelId: 'ch-1' };
      const project = { name: 'proj', projectPath: '/tmp/proj' };
      const deps = createDeps();
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (getPrimaryInstanceForAgent as any).mockReturnValue(instance);

      (existsSync as any).mockReturnValue(true);
      // Simulate symlink resolving outside project
      (realpathSync as any).mockReturnValue('/etc/passwd');

      const routes = new HookRuntimeRoutes(deps);

      const result = await routes.handleSendFiles({
        projectName: 'proj',
        files: ['/tmp/proj/sneaky-link'],
      });

      expect(result).toEqual({ status: 400, message: 'No valid files' });
      expect(deps.messaging.sendToChannelWithFiles).not.toHaveBeenCalled();
    });

    it('uses instanceId to look up instance when provided', async () => {
      const instance = { instanceId: 'opencode-2', agentType: 'opencode', channelId: 'ch-2' };
      const project = { name: 'proj', projectPath: '/tmp/proj' };
      const deps = createDeps();
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (getProjectInstance as any).mockReturnValue(instance);

      (existsSync as any).mockReturnValue(true);
      (realpathSync as any).mockImplementation((p: string) => p);

      const routes = new HookRuntimeRoutes(deps);

      const result = await routes.handleSendFiles({
        projectName: 'proj',
        instanceId: 'opencode-2',
        files: ['/tmp/proj/file.txt'],
      });

      expect(result).toEqual({ status: 200, message: 'OK' });
      expect(getProjectInstance).toHaveBeenCalledWith(project, 'opencode-2');
      expect(deps.messaging.sendToChannelWithFiles).toHaveBeenCalledWith('ch-2', '', ['/tmp/proj/file.txt']);
    });

    it('falls back to getPrimaryInstanceForAgent when instanceId lookup returns undefined', async () => {
      const primaryInstance = { instanceId: 'opencode', agentType: 'opencode', channelId: 'ch-1' };
      const project = { name: 'proj', projectPath: '/tmp/proj' };
      const deps = createDeps();
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (getProjectInstance as any).mockReturnValue(undefined);
      (getPrimaryInstanceForAgent as any).mockReturnValue(primaryInstance);

      (existsSync as any).mockReturnValue(true);
      (realpathSync as any).mockImplementation((p: string) => p);

      const routes = new HookRuntimeRoutes(deps);

      const result = await routes.handleSendFiles({
        projectName: 'proj',
        instanceId: 'missing-instance',
        agentType: 'opencode',
        files: ['/tmp/proj/file.txt'],
      });

      expect(result).toEqual({ status: 200, message: 'OK' });
      expect(getPrimaryInstanceForAgent).toHaveBeenCalledWith(project, 'opencode');
    });

    it('defaults agentType to opencode when not specified', async () => {
      const primaryInstance = { instanceId: 'opencode', agentType: 'opencode', channelId: 'ch-1' };
      const project = { name: 'proj', projectPath: '/tmp/proj' };
      const deps = createDeps();
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (getPrimaryInstanceForAgent as any).mockReturnValue(primaryInstance);

      (existsSync as any).mockReturnValue(true);
      (realpathSync as any).mockImplementation((p: string) => p);

      const routes = new HookRuntimeRoutes(deps);

      await routes.handleSendFiles({
        projectName: 'proj',
        files: ['/tmp/proj/file.txt'],
      });

      expect(getPrimaryInstanceForAgent).toHaveBeenCalledWith(project, 'opencode');
    });

    it('filters non-string values from files array', async () => {
      const instance = { instanceId: 'opencode', agentType: 'opencode', channelId: 'ch-1' };
      const project = { name: 'proj', projectPath: '/tmp/proj' };
      const deps = createDeps();
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (getPrimaryInstanceForAgent as any).mockReturnValue(instance);

      (existsSync as any).mockReturnValue(true);
      (realpathSync as any).mockImplementation((p: string) => p);

      const routes = new HookRuntimeRoutes(deps);

      const result = await routes.handleSendFiles({
        projectName: 'proj',
        files: ['/tmp/proj/file.txt', 123, null, undefined, '/tmp/proj/other.txt'],
      });

      expect(result).toEqual({ status: 200, message: 'OK' });
      expect(deps.messaging.sendToChannelWithFiles).toHaveBeenCalledWith(
        'ch-1',
        '',
        ['/tmp/proj/file.txt', '/tmp/proj/other.txt'],
      );
    });

    it('returns 400 with no valid files when projectPath is empty', async () => {
      const instance = { instanceId: 'opencode', agentType: 'opencode', channelId: 'ch-1' };
      const project = { name: 'proj', projectPath: '' };
      const deps = createDeps();
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (getPrimaryInstanceForAgent as any).mockReturnValue(instance);

      (existsSync as any).mockReturnValue(true);
      (realpathSync as any).mockImplementation((p: string) => p);

      const routes = new HookRuntimeRoutes(deps);

      const result = await routes.handleSendFiles({
        projectName: 'proj',
        files: ['/tmp/proj/file.txt'],
      });

      expect(result).toEqual({ status: 400, message: 'No valid files' });
    });
});
