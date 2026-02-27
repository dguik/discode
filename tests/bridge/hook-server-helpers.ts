import { vi } from 'vitest';
import http from 'http';
import { BridgeHookServer, type BridgeHookServerDeps } from '../../src/bridge/hook-server.js';

export function createMockMessaging(platform: 'slack' | 'discord' = 'slack') {
  return {
    platform,
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    sendToChannelWithId: vi.fn().mockResolvedValue('start-msg-ts'),
    sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    replyInThread: vi.fn().mockResolvedValue(undefined),
    replyInThreadWithId: vi.fn().mockResolvedValue('thread-msg-ts'),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    sendQuestionWithButtons: vi.fn().mockResolvedValue(null),
  };
}

export function createMockPendingTracker() {
  return {
    markPending: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markError: vi.fn().mockResolvedValue(undefined),
    hasPending: vi.fn().mockReturnValue(true),
    ensurePending: vi.fn().mockResolvedValue(undefined),
    ensureStartMessage: vi.fn().mockResolvedValue(undefined),
    getPending: vi.fn().mockReturnValue(undefined),
    setHookActive: vi.fn(),
    isHookActive: vi.fn().mockReturnValue(false),
  };
}

export function createMockStreamingUpdater() {
  return {
    canStream: vi.fn().mockReturnValue(false),
    start: vi.fn(),
    append: vi.fn().mockReturnValue(false),
    finalize: vi.fn().mockResolvedValue(undefined),
    discard: vi.fn(),
    has: vi.fn().mockReturnValue(false),
  };
}

export function createMockStateManager(projects: Record<string, any> = {}) {
  return {
    getProject: vi.fn((name: string) => projects[name]),
    setProject: vi.fn(),
    listProjects: vi.fn().mockReturnValue(Object.values(projects)),
    reload: vi.fn(),
    removeProject: vi.fn(),
    getGuildId: vi.fn(),
    setGuildId: vi.fn(),
    updateLastActive: vi.fn(),
    findProjectByChannel: vi.fn(),
    getAgentTypeByChannel: vi.fn(),
  };
}

/** Default test auth token used by createServerDeps and request helpers. */
export const TEST_AUTH_TOKEN = 'test-hook-token-for-vitest';

export function postJSON(port: number, path: string, body: unknown, token?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers: Record<string, string | number> = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    const t = token ?? TEST_AUTH_TOKEN;
    if (t) headers['Authorization'] = `Bearer ${t}`;
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

export function getRequest(port: number, path: string, token?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    const t = token ?? TEST_AUTH_TOKEN;
    if (t) headers['Authorization'] = `Bearer ${t}`;
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export function postRaw(port: number, path: string, body: string, token?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    const t = token ?? TEST_AUTH_TOKEN;
    if (t) headers['Authorization'] = `Bearer ${t}`;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export function createServerDeps(port: number, overrides: Partial<BridgeHookServerDeps> = {}): BridgeHookServerDeps {
  return {
    port,
    messaging: createMockMessaging() as any,
    stateManager: createMockStateManager() as any,
    pendingTracker: createMockPendingTracker() as any,
    streamingUpdater: createMockStreamingUpdater() as any,
    reloadChannelMappings: vi.fn(),
    authToken: TEST_AUTH_TOKEN,
    ...overrides,
  };
}

/**
 * Create, start, and wait for a BridgeHookServer with port 0 (OS-assigned).
 * Returns the server and the actual port.
 */
export async function startServerOnFreePort(
  overrides: Partial<BridgeHookServerDeps> = {},
): Promise<{ server: BridgeHookServer; port: number }> {
  const srv = new BridgeHookServer(createServerDeps(0, overrides));
  srv.start();
  await srv.ready();
  const addr = srv.address();
  if (!addr) throw new Error('Server did not bind');
  return { server: srv, port: addr.port };
}
