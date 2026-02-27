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
  readHookToken: () => 'mock-hook-token',
}));

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
});
