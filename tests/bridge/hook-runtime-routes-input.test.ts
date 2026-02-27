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

function createDeps(overrides: Partial<RuntimeRoutesDeps> = {}): RuntimeRoutesDeps {
  return {
    port: 18470,
    messaging: createMockMessaging(),
    stateManager: createMockStateManager(),
    runtime: createMockRuntime(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HookRuntimeRoutes — input & stop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
