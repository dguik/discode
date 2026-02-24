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
  agentRegistry: {
    get: vi.fn(),
  },
}));

vi.mock('../../src/policy/agent-integration.js', () => ({
  installAgentIntegration: vi.fn(() => ({
    agentType: 'opencode',
    eventHookInstalled: true,
    infoMessages: [],
    warningMessages: [],
  })),
}));

vi.mock('../../src/policy/agent-launch.js', () => ({
  buildAgentLaunchEnv: vi.fn(() => ({ DISCODE_PORT: '18470' })),
  buildExportPrefix: vi.fn(() => 'export DISCODE_PORT=18470; '),
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

function createMockRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    getOrCreateSession: vi.fn().mockReturnValue('sess'),
    setSessionEnv: vi.fn(),
    windowExists: vi.fn().mockReturnValue(true),
    startAgentInWindow: vi.fn(),
    sendKeysToWindow: vi.fn(),
    typeKeysToWindow: vi.fn(),
    sendEnterToWindow: vi.fn(),
    listWindows: vi.fn().mockReturnValue([
      { sessionName: 'sess', windowName: 'win1', status: 'running' },
    ]),
    getWindowBuffer: vi.fn().mockReturnValue('buffer-content-here'),
    stopWindow: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

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

function createRes() {
  return { writeHead: vi.fn(), end: vi.fn() };
}

function createDeps(overrides: Partial<RuntimeRoutesDeps> = {}): RuntimeRoutesDeps {
  return {
    port: 18470,
    messaging: createMockMessaging(),
    stateManager: createMockStateManager(),
    runtime: createMockRuntime(),
    ...overrides,
  };
}

function parsedJson(res: ReturnType<typeof createRes>) {
  return JSON.parse(res.end.mock.calls[0][0]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HookRuntimeRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // handleRuntimeWindows
  // -------------------------------------------------------------------------
  describe('handleRuntimeWindows', () => {
    it('returns 501 when runtime is unavailable', () => {
      const deps = createDeps({ runtime: undefined });
      const routes = new HookRuntimeRoutes(deps);
      const res = createRes();

      routes.handleRuntimeWindows(res);

      expect(res.writeHead).toHaveBeenCalledWith(501, expect.any(Object));
      expect(parsedJson(res)).toEqual({ error: 'Runtime control unavailable' });
    });

    it('returns 501 when runtime has no listWindows method', () => {
      const runtime = createMockRuntime();
      delete (runtime as any).listWindows;
      const deps = createDeps({ runtime });
      const routes = new HookRuntimeRoutes(deps);
      const res = createRes();

      routes.handleRuntimeWindows(res);

      expect(res.writeHead).toHaveBeenCalledWith(501, expect.any(Object));
    });

    it('returns 501 when runtime has no getWindowBuffer method', () => {
      const runtime = createMockRuntime();
      delete (runtime as any).getWindowBuffer;
      const deps = createDeps({ runtime });
      const routes = new HookRuntimeRoutes(deps);
      const res = createRes();

      routes.handleRuntimeWindows(res);

      expect(res.writeHead).toHaveBeenCalledWith(501, expect.any(Object));
    });

    it('returns 200 with window list when runtime is available', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);
      const res = createRes();

      routes.handleRuntimeWindows(res);

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const body = parsedJson(res);
      expect(body.windows).toHaveLength(1);
      expect(body.windows[0].windowId).toBe('sess:win1');
      expect(body.windows[0].sessionName).toBe('sess');
      expect(body.windows[0].windowName).toBe('win1');
      expect(body.activeWindowId).toBe('sess:win1');
    });

    it('returns empty window list when runtime lists no windows', () => {
      const runtime = createMockRuntime({
        listWindows: vi.fn().mockReturnValue([]),
      });
      const deps = createDeps({ runtime });
      const routes = new HookRuntimeRoutes(deps);
      const res = createRes();

      routes.handleRuntimeWindows(res);

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const body = parsedJson(res);
      expect(body.windows).toHaveLength(0);
    });

    it('sets Content-Type to application/json', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);
      const res = createRes();

      routes.handleRuntimeWindows(res);

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'application/json; charset=utf-8',
      });
    });
  });

  // -------------------------------------------------------------------------
  // handleRuntimeBuffer
  // -------------------------------------------------------------------------
  describe('handleRuntimeBuffer', () => {
    it('returns 501 when runtime is unavailable', () => {
      const deps = createDeps({ runtime: undefined });
      const routes = new HookRuntimeRoutes(deps);
      const res = createRes();

      routes.handleRuntimeBuffer(res, 'sess:win1', 0);

      expect(res.writeHead).toHaveBeenCalledWith(501, expect.any(Object));
      expect(parsedJson(res)).toEqual({ error: 'Runtime control unavailable' });
    });

    it('returns 400 when windowId is missing', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);
      const res = createRes();

      routes.handleRuntimeBuffer(res, undefined, 0);

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(parsedJson(res)).toEqual({ error: 'Missing windowId' });
    });

    it('returns 404 when window does not exist', () => {
      const runtime = createMockRuntime({
        windowExists: vi.fn().mockReturnValue(false),
      });
      const deps = createDeps({ runtime });
      const routes = new HookRuntimeRoutes(deps);
      const res = createRes();

      routes.handleRuntimeBuffer(res, 'sess:win1', 0);

      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
      expect(parsedJson(res)).toEqual({ error: 'Window not found' });
    });

    it('returns 200 with buffer data on success', () => {
      const runtime = createMockRuntime({
        getWindowBuffer: vi.fn().mockReturnValue('hello world'),
      });
      const deps = createDeps({ runtime });
      const routes = new HookRuntimeRoutes(deps);
      const res = createRes();

      routes.handleRuntimeBuffer(res, 'sess:win1', 0);

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      const body = parsedJson(res);
      expect(body.windowId).toBe('sess:win1');
      expect(body.chunk).toBe('hello world');
      expect(body.since).toBe(0);
      expect(body.next).toBe(11);
    });

    it('returns buffer slice starting from since offset', () => {
      const runtime = createMockRuntime({
        getWindowBuffer: vi.fn().mockReturnValue('hello world'),
      });
      const deps = createDeps({ runtime });
      const routes = new HookRuntimeRoutes(deps);
      const res = createRes();

      routes.handleRuntimeBuffer(res, 'sess:win1', 6);

      const body = parsedJson(res);
      expect(body.chunk).toBe('world');
      expect(body.since).toBe(6);
      expect(body.next).toBe(11);
    });

    it('returns 404 for invalid windowId format', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);
      const res = createRes();

      routes.handleRuntimeBuffer(res, 'invalid-no-colon', 0);

      // parseWindowId returns null => Invalid windowId error => 404 path
      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });
  });

  // -------------------------------------------------------------------------
  // handleRuntimeFocus
  // -------------------------------------------------------------------------
  describe('handleRuntimeFocus', () => {
    it('returns 501 when runtime is unavailable', () => {
      const deps = createDeps({ runtime: undefined });
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeFocus({ windowId: 'sess:win1' });

      expect(result).toEqual({ status: 501, message: 'Runtime control unavailable' });
    });

    it('returns 400 when payload is null', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeFocus(null);

      expect(result).toEqual({ status: 400, message: 'Invalid payload' });
    });

    it('returns 400 when payload is not an object', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeFocus('string-payload');

      expect(result).toEqual({ status: 400, message: 'Invalid payload' });
    });

    it('returns 400 when windowId is missing from payload', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeFocus({});

      expect(result).toEqual({ status: 400, message: 'Missing windowId' });
    });

    it('returns 400 when windowId is not a string', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeFocus({ windowId: 123 });

      expect(result).toEqual({ status: 400, message: 'Missing windowId' });
    });

    it('returns 404 when window does not exist', () => {
      const runtime = createMockRuntime({
        windowExists: vi.fn().mockReturnValue(false),
      });
      const deps = createDeps({ runtime });
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeFocus({ windowId: 'sess:win1' });

      expect(result).toEqual({ status: 404, message: 'Window not found' });
    });

    it('returns 200 on successful focus', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeFocus({ windowId: 'sess:win1' });

      expect(result).toEqual({ status: 200, message: 'OK' });
    });
  });

  // -------------------------------------------------------------------------
  // handleRuntimeInput
  // -------------------------------------------------------------------------
  describe('handleRuntimeInput', () => {
    it('returns 501 when runtime is unavailable', () => {
      const deps = createDeps({ runtime: undefined });
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeInput({ windowId: 'sess:win1', text: 'hi' });

      expect(result).toEqual({ status: 501, message: 'Runtime control unavailable' });
    });

    it('returns 400 when payload is null', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeInput(null);

      expect(result).toEqual({ status: 400, message: 'Invalid payload' });
    });

    it('returns 400 when payload is not an object', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeInput(42);

      expect(result).toEqual({ status: 400, message: 'Invalid payload' });
    });

    it('returns 400 when windowId is missing and no active window', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeInput({ text: 'hello' });

      expect(result).toEqual({ status: 400, message: 'Missing windowId' });
    });

    it('returns 400 when no text and submit is false', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeInput({ windowId: 'sess:win1', submit: false });

      expect(result).toEqual({ status: 400, message: 'No input to send' });
    });

    it('returns 404 when window does not exist', () => {
      const runtime = createMockRuntime({
        windowExists: vi.fn().mockReturnValue(false),
      });
      const deps = createDeps({ runtime });
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeInput({ windowId: 'sess:win1', text: 'hi' });

      expect(result).toEqual({ status: 404, message: 'Window not found' });
    });

    it('returns 200 on successful input with text and submit', () => {
      const runtime = createMockRuntime();
      const deps = createDeps({ runtime });
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeInput({
        windowId: 'sess:win1',
        text: 'hello',
        submit: true,
      });

      expect(result).toEqual({ status: 200, message: 'OK' });
      expect(runtime.typeKeysToWindow).toHaveBeenCalledWith('sess', 'win1', 'hello');
      expect(runtime.sendEnterToWindow).toHaveBeenCalledWith('sess', 'win1');
    });

    it('returns 200 when only submit is true (no text)', () => {
      const runtime = createMockRuntime();
      const deps = createDeps({ runtime });
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeInput({
        windowId: 'sess:win1',
        submit: true,
      });

      expect(result).toEqual({ status: 200, message: 'OK' });
      expect(runtime.typeKeysToWindow).not.toHaveBeenCalled();
      expect(runtime.sendEnterToWindow).toHaveBeenCalledWith('sess', 'win1');
    });

    it('returns 200 when text is provided without explicit submit (defaults to true)', () => {
      const runtime = createMockRuntime();
      const deps = createDeps({ runtime });
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeInput({
        windowId: 'sess:win1',
        text: 'command',
      });

      expect(result).toEqual({ status: 200, message: 'OK' });
      expect(runtime.typeKeysToWindow).toHaveBeenCalledWith('sess', 'win1', 'command');
      expect(runtime.sendEnterToWindow).toHaveBeenCalledWith('sess', 'win1');
    });

    it('sends text without enter when submit is false', () => {
      const runtime = createMockRuntime();
      const deps = createDeps({ runtime });
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeInput({
        windowId: 'sess:win1',
        text: 'partial',
        submit: false,
      });

      expect(result).toEqual({ status: 200, message: 'OK' });
      expect(runtime.typeKeysToWindow).toHaveBeenCalledWith('sess', 'win1', 'partial');
      expect(runtime.sendEnterToWindow).not.toHaveBeenCalled();
    });

    it('uses active window when windowId is omitted but active window exists', () => {
      const runtime = createMockRuntime();
      const deps = createDeps({ runtime });
      const routes = new HookRuntimeRoutes(deps);

      // First call to establish active window via focus
      routes.handleRuntimeFocus({ windowId: 'sess:win1' });

      // Now input without windowId
      const result = routes.handleRuntimeInput({ text: 'hello' });

      expect(result).toEqual({ status: 200, message: 'OK' });
    });
  });

  // -------------------------------------------------------------------------
  // handleRuntimeStop
  // -------------------------------------------------------------------------
  describe('handleRuntimeStop', () => {
    it('returns 501 when runtime is unavailable', () => {
      const deps = createDeps({ runtime: undefined });
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeStop({ windowId: 'sess:win1' });

      expect(result).toEqual({ status: 501, message: 'Runtime control unavailable' });
    });

    it('returns 400 when payload is null', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeStop(null);

      expect(result).toEqual({ status: 400, message: 'Invalid payload' });
    });

    it('returns 400 when payload is not an object', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeStop('bad');

      expect(result).toEqual({ status: 400, message: 'Invalid payload' });
    });

    it('returns 400 when windowId is missing', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeStop({});

      expect(result).toEqual({ status: 400, message: 'Missing windowId' });
    });

    it('returns 400 when windowId is not a string', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeStop({ windowId: 999 });

      expect(result).toEqual({ status: 400, message: 'Missing windowId' });
    });

    it('returns 404 when window does not exist', () => {
      const runtime = createMockRuntime({
        windowExists: vi.fn().mockReturnValue(false),
      });
      const deps = createDeps({ runtime });
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeStop({ windowId: 'sess:win1' });

      expect(result).toEqual({ status: 404, message: 'Window not found' });
    });

    it('returns 200 on successful stop', () => {
      const runtime = createMockRuntime();
      const deps = createDeps({ runtime });
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeStop({ windowId: 'sess:win1' });

      expect(result).toEqual({ status: 200, message: 'OK' });
      expect(runtime.stopWindow).toHaveBeenCalledWith('sess', 'win1');
    });

    it('returns 501 when runtime.stopWindow is not available', () => {
      const runtime = createMockRuntime();
      delete (runtime as any).stopWindow;
      const deps = createDeps({ runtime });
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeStop({ windowId: 'sess:win1' });

      expect(result).toEqual({ status: 501, message: 'Runtime stop unavailable' });
    });
  });

  // -------------------------------------------------------------------------
  // handleRuntimeEnsure
  // -------------------------------------------------------------------------
  describe('handleRuntimeEnsure', () => {
    it('returns 501 when runtime is unavailable', () => {
      const deps = createDeps({ runtime: undefined });
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeEnsure({ projectName: 'proj' });

      expect(result).toEqual({ status: 501, message: 'Runtime control unavailable' });
    });

    it('returns 400 when payload is null', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeEnsure(null);

      expect(result).toEqual({ status: 400, message: 'Invalid payload' });
    });

    it('returns 400 when projectName is missing', () => {
      const deps = createDeps();
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeEnsure({});

      expect(result).toEqual({ status: 400, message: 'Missing projectName' });
    });

    it('returns 404 when project is not found in state', () => {
      const deps = createDeps();
      (deps.stateManager.getProject as any).mockReturnValue(undefined);
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeEnsure({ projectName: 'unknown' });

      expect(result).toEqual({ status: 404, message: 'Project not found' });
    });

    it('returns 404 when instance is not found', () => {
      const project = { name: 'proj', projectPath: '/tmp/proj', tmuxSession: 'sess' };
      const deps = createDeps();
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (listProjectInstances as any).mockReturnValue([]);
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeEnsure({ projectName: 'proj' });

      expect(result).toEqual({ status: 404, message: 'Instance not found' });
    });

    it('returns 404 when agent adapter is not found', () => {
      const instance = { instanceId: 'opencode', agentType: 'opencode', tmuxWindow: 'win1', channelId: 'ch-1' };
      const project = { name: 'proj', projectPath: '/tmp/proj', tmuxSession: 'sess', instances: { opencode: instance } };
      const deps = createDeps();
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (listProjectInstances as any).mockReturnValue([instance]);
      (agentRegistry.get as any).mockReturnValue(undefined);
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeEnsure({ projectName: 'proj' });

      expect(result).toEqual({ status: 404, message: 'Agent adapter not found' });
    });

    it('returns 400 when tmuxWindow or tmuxSession is missing', () => {
      const instance = { instanceId: 'opencode', agentType: 'opencode', tmuxWindow: undefined, channelId: 'ch-1' };
      const project = { name: 'proj', projectPath: '/tmp/proj', tmuxSession: 'sess', instances: { opencode: instance } };
      const deps = createDeps();
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (listProjectInstances as any).mockReturnValue([instance]);
      (agentRegistry.get as any).mockReturnValue({
        buildLaunchCommand: vi.fn((cmd: string) => cmd),
        getStartCommand: vi.fn(() => 'opencode'),
        getExtraEnvVars: vi.fn(() => ({})),
      });
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeEnsure({ projectName: 'proj' });

      expect(result).toEqual({ status: 400, message: 'Invalid project state' });
    });

    it('returns 200 when window already exists without starting agent', () => {
      const instance = { instanceId: 'opencode', agentType: 'opencode', tmuxWindow: 'win1', channelId: 'ch-1' };
      const project = { name: 'proj', projectPath: '/tmp/proj', tmuxSession: 'sess', instances: { opencode: instance } };
      const runtime = createMockRuntime({
        windowExists: vi.fn().mockReturnValue(true),
      });
      const deps = createDeps({ runtime });
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (listProjectInstances as any).mockReturnValue([instance]);
      (agentRegistry.get as any).mockReturnValue({
        buildLaunchCommand: vi.fn((cmd: string) => cmd),
        getStartCommand: vi.fn(() => 'opencode'),
        getExtraEnvVars: vi.fn(() => ({})),
      });
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeEnsure({ projectName: 'proj' });

      expect(result).toEqual({ status: 200, message: 'OK' });
      expect(runtime.startAgentInWindow).not.toHaveBeenCalled();
      expect(runtime.setSessionEnv).toHaveBeenCalledWith('sess', 'DISCODE_PORT', '18470');
    });

    it('starts agent in window when window does not exist', () => {
      const instance = { instanceId: 'opencode', agentType: 'opencode', tmuxWindow: 'win1', channelId: 'ch-1' };
      const project = { name: 'proj', projectPath: '/tmp/proj', tmuxSession: 'sess', instances: { opencode: instance } };
      const runtime = createMockRuntime({
        windowExists: vi.fn().mockReturnValue(false),
      });
      const deps = createDeps({ runtime });
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (listProjectInstances as any).mockReturnValue([instance]);
      const mockAdapter = {
        buildLaunchCommand: vi.fn((cmd: string) => cmd),
        getStartCommand: vi.fn(() => 'opencode'),
        getExtraEnvVars: vi.fn(() => ({})),
      };
      (agentRegistry.get as any).mockReturnValue(mockAdapter);
      (installAgentIntegration as any).mockReturnValue({
        agentType: 'opencode',
        eventHookInstalled: true,
        infoMessages: [],
        warningMessages: [],
      });
      (buildExportPrefix as any).mockReturnValue('export DISCODE_PORT=18470; ');
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeEnsure({ projectName: 'proj' });

      expect(result).toEqual({ status: 200, message: 'OK' });
      expect(runtime.startAgentInWindow).toHaveBeenCalledWith(
        'sess',
        'win1',
        expect.stringContaining('export DISCODE_PORT=18470; '),
      );
      expect(installAgentIntegration).toHaveBeenCalledWith('opencode', '/tmp/proj', 'reinstall');
      expect(buildAgentLaunchEnv).toHaveBeenCalled();
    });

    it('looks up instance by instanceId when provided', () => {
      const instance = { instanceId: 'opencode-2', agentType: 'opencode', tmuxWindow: 'win2', channelId: 'ch-2' };
      const project = { name: 'proj', projectPath: '/tmp/proj', tmuxSession: 'sess', instances: { 'opencode-2': instance } };
      const runtime = createMockRuntime({
        windowExists: vi.fn().mockReturnValue(true),
      });
      const deps = createDeps({ runtime });
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (getProjectInstance as any).mockReturnValue(instance);
      (agentRegistry.get as any).mockReturnValue({
        buildLaunchCommand: vi.fn((cmd: string) => cmd),
        getStartCommand: vi.fn(() => 'opencode'),
        getExtraEnvVars: vi.fn(() => ({})),
      });
      const routes = new HookRuntimeRoutes(deps);

      const result = routes.handleRuntimeEnsure({
        projectName: 'proj',
        instanceId: 'opencode-2',
      });

      expect(result).toEqual({ status: 200, message: 'OK' });
      expect(getProjectInstance).toHaveBeenCalledWith(project, 'opencode-2');
    });

    it('passes permissionAllow to adapter.getExtraEnvVars', () => {
      const instance = { instanceId: 'opencode', agentType: 'opencode', tmuxWindow: 'win1', channelId: 'ch-1' };
      const project = { name: 'proj', projectPath: '/tmp/proj', tmuxSession: 'sess', instances: { opencode: instance } };
      const runtime = createMockRuntime({
        windowExists: vi.fn().mockReturnValue(false),
      });
      const deps = createDeps({ runtime });
      (deps.stateManager.getProject as any).mockReturnValue(project);
      (normalizeProjectState as any).mockReturnValue(project);
      (listProjectInstances as any).mockReturnValue([instance]);
      const mockAdapter = {
        buildLaunchCommand: vi.fn((cmd: string) => cmd),
        getStartCommand: vi.fn(() => 'opencode'),
        getExtraEnvVars: vi.fn(() => ({})),
      };
      (agentRegistry.get as any).mockReturnValue(mockAdapter);
      const routes = new HookRuntimeRoutes(deps);

      routes.handleRuntimeEnsure({
        projectName: 'proj',
        permissionAllow: true,
      });

      expect(mockAdapter.getExtraEnvVars).toHaveBeenCalledWith({ permissionAllow: true });
      expect(mockAdapter.getStartCommand).toHaveBeenCalledWith('/tmp/proj', true);
    });
  });

  // -------------------------------------------------------------------------
  // handleSendFiles
  // -------------------------------------------------------------------------
  describe('handleSendFiles', () => {
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
});
