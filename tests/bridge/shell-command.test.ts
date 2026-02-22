/**
 * Tests for shell command execution from Slack/Discord.
 *
 * Messages starting with `!` are intercepted and executed directly on the host
 * without going through the agent. Results are sent back as code blocks.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock('../../src/infra/file-downloader.js', () => ({
  downloadFileAttachments: vi.fn().mockResolvedValue([]),
  buildFileMarkers: vi.fn().mockReturnValue(''),
}));

vi.mock('../../src/container/index.js', () => ({
  injectFile: vi.fn().mockReturnValue(true),
  WORKSPACE_DIR: '/workspace',
}));

const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
}));

// ── Imports ─────────────────────────────────────────────────────────

import { BridgeMessageRouter } from '../../src/bridge/message-router.js';
import { normalizeProjectState } from '../../src/state/instances.js';

// ── Helpers ─────────────────────────────────────────────────────────

function createMockMessaging(platform: 'discord' | 'slack' = 'discord') {
  return {
    platform,
    onMessage: vi.fn(),
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockRuntime() {
  return {
    sendKeysToWindow: vi.fn(),
    typeKeysToWindow: vi.fn(),
    sendEnterToWindow: vi.fn(),
  } as any;
}

function createMockStateManager(project: any) {
  return {
    getProject: vi.fn().mockReturnValue(project),
    updateLastActive: vi.fn(),
  } as any;
}

function createMockPendingTracker() {
  return {
    markPending: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markError: vi.fn().mockResolvedValue(undefined),
    hasPending: vi.fn().mockReturnValue(false),
    ensurePending: vi.fn().mockResolvedValue(undefined),
    getPending: vi.fn().mockReturnValue(undefined),
  } as any;
}

function createMockStreamingUpdater() {
  return { start: vi.fn(), stop: vi.fn() } as any;
}

function createProject() {
  return normalizeProjectState({
    projectName: 'myapp',
    projectPath: '/home/user/myapp',
    tmuxSession: 'bridge',
    discordChannels: { claude: 'ch-1' },
    agents: { claude: true },
    instances: {
      claude: {
        instanceId: 'claude',
        agentType: 'claude',
        tmuxWindow: 'myapp-claude',
        channelId: 'ch-1',
      },
    },
    createdAt: new Date(),
    lastActive: new Date(),
  });
}

/** Register the router and return the captured onMessage callback. */
function setupRouter(overrides: Record<string, any> = {}) {
  const project = createProject();
  const messaging = createMockMessaging(overrides.platform ?? 'discord');
  const runtime = createMockRuntime();
  const stateManager = createMockStateManager(project);
  const pendingTracker = createMockPendingTracker();
  const streamingUpdater = createMockStreamingUpdater();

  const router = new BridgeMessageRouter({
    messaging,
    runtime,
    stateManager,
    pendingTracker,
    streamingUpdater,
    sanitizeInput: (s: string) => (s.trim().length === 0 || s.length > 10000 ? null : s),
  });

  router.register();

  // Extract the registered onMessage callback
  const onMessage = messaging.onMessage.mock.calls[0][0] as (
    agentType: string,
    content: string,
    projectName: string,
    channelId: string,
    messageId?: string,
  ) => Promise<void>;

  return { messaging, runtime, stateManager, pendingTracker, onMessage };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('shell command execution (!prefix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes shell command and sends stdout as code block', async () => {
    mockExecSync.mockReturnValue('hello world\n');
    const { messaging, onMessage } = setupRouter();

    await onMessage('claude', '!echo hello', 'myapp', 'ch-1', 'msg-1');

    expect(mockExecSync).toHaveBeenCalledWith('echo hello', {
      cwd: '/home/user/myapp',
      timeout: 30_000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', '```\nhello world\n```');
  });

  it('does not submit to agent when ! prefix is used', async () => {
    mockExecSync.mockReturnValue('output\n');
    const { runtime, onMessage } = setupRouter();

    await onMessage('claude', '!ls', 'myapp', 'ch-1', 'msg-1');

    expect(runtime.typeKeysToWindow).not.toHaveBeenCalled();
    expect(runtime.sendEnterToWindow).not.toHaveBeenCalled();
  });

  it('does not call markPending for shell commands', async () => {
    mockExecSync.mockReturnValue('ok\n');
    const { pendingTracker, onMessage } = setupRouter();

    await onMessage('claude', '!pwd', 'myapp', 'ch-1', 'msg-1');

    expect(pendingTracker.markPending).not.toHaveBeenCalled();
  });

  it('updates lastActive for shell commands', async () => {
    mockExecSync.mockReturnValue('ok\n');
    const { stateManager, onMessage } = setupRouter();

    await onMessage('claude', '!date', 'myapp', 'ch-1');

    expect(stateManager.updateLastActive).toHaveBeenCalledWith('myapp');
  });

  it('sends no-output message when command produces empty output', async () => {
    mockExecSync.mockReturnValue('');
    const { messaging, onMessage } = setupRouter();

    await onMessage('claude', '!true', 'myapp', 'ch-1');

    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', '✅ (no output)');
  });

  it('sends error with exit code on command failure', async () => {
    const error: any = new Error('Command failed');
    error.status = 2;
    error.stdout = '';
    error.stderr = 'No such file or directory\n';
    mockExecSync.mockImplementation(() => { throw error; });

    const { messaging, onMessage } = setupRouter();

    await onMessage('claude', '!ls /nonexistent', 'myapp', 'ch-1');

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      '⚠️ Exit code 2\n```\nNo such file or directory\n```',
    );
  });

  it('sends error with no output when command fails silently', async () => {
    const error: any = new Error('Command failed');
    error.status = 1;
    error.stdout = '';
    error.stderr = '';
    mockExecSync.mockImplementation(() => { throw error; });

    const { messaging, onMessage } = setupRouter();

    await onMessage('claude', '!false', 'myapp', 'ch-1');

    expect(messaging.sendToChannel).toHaveBeenCalledWith('ch-1', '⚠️ Exit code 1 (no output)');
  });

  it('does nothing for bare ! with no command', async () => {
    const { messaging, runtime, onMessage } = setupRouter();

    await onMessage('claude', '!', 'myapp', 'ch-1');

    // No shell execution
    expect(mockExecSync).not.toHaveBeenCalled();
    // No agent submission
    expect(runtime.typeKeysToWindow).not.toHaveBeenCalled();
    // No message sent
    expect(messaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('sets cwd to projectPath', async () => {
    mockExecSync.mockReturnValue('output\n');
    const { onMessage } = setupRouter();

    await onMessage('claude', '!git status', 'myapp', 'ch-1');

    expect(mockExecSync.mock.calls[0][1]).toMatchObject({ cwd: '/home/user/myapp' });
  });

  it('combines stdout and stderr on error', async () => {
    const error: any = new Error('Command failed');
    error.status = 1;
    error.stdout = 'partial output\n';
    error.stderr = 'error details\n';
    mockExecSync.mockImplementation(() => { throw error; });

    const { messaging, onMessage } = setupRouter();

    await onMessage('claude', '!bad-cmd', 'myapp', 'ch-1');

    expect(messaging.sendToChannel).toHaveBeenCalledWith(
      'ch-1',
      '⚠️ Exit code 1\n```\npartial output\nerror details\n```',
    );
  });
});
