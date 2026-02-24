import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BridgeHookServer } from '../../src/bridge/hook-server.js';
import type { BridgeHookServerDeps } from '../../src/bridge/hook-server.js';

function createMockMessaging() {
  return {
    platform: 'slack' as const,
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    sendToChannelWithId: vi.fn().mockResolvedValue('start-msg-ts'),
    sendToChannelWithFiles: vi.fn().mockResolvedValue(undefined),
    addReactionToMessage: vi.fn().mockResolvedValue(undefined),
    replaceOwnReactionOnMessage: vi.fn().mockResolvedValue(undefined),
    replyInThread: vi.fn().mockResolvedValue(undefined),
    replyInThreadWithId: vi.fn().mockResolvedValue('thread-msg-ts'),
    updateMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockPendingTracker() {
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

function createMockStreamingUpdater() {
  return {
    canStream: vi.fn().mockReturnValue(false),
    start: vi.fn(),
    append: vi.fn().mockReturnValue(false),
    finalize: vi.fn().mockResolvedValue(undefined),
    discard: vi.fn(),
    has: vi.fn().mockReturnValue(false),
  };
}

function createMockStateManager(projects: Record<string, any> = {}) {
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

function postJSON(port: number, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
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

function getRequest(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
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

function postRaw(port: number, path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
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

describe('BridgeHookServer', () => {
  let tempDir: string;
  let server: BridgeHookServer;
  let port: number;

  beforeEach(() => {
    // Use realpathSync to resolve macOS symlinks (/var → /private/var)
    // so that validateFilePaths' realpathSync check doesn't fail.
    const rawDir = join(tmpdir(), `discode-hookserver-test-${Date.now()}`);
    mkdirSync(rawDir, { recursive: true });
    tempDir = realpathSync(rawDir);
    // Use a random high port to avoid conflicts
    port = 19000 + Math.floor(Math.random() * 1000);
  });

  afterEach(() => {
    server?.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function startServer(deps: Partial<BridgeHookServerDeps> = {}): BridgeHookServer {
    const fullDeps: BridgeHookServerDeps = {
      port,
      messaging: createMockMessaging() as any,
      stateManager: createMockStateManager() as any,
      pendingTracker: createMockPendingTracker() as any,
      streamingUpdater: createMockStreamingUpdater() as any,
      reloadChannelMappings: vi.fn(),
      ...deps,
    };
    server = new BridgeHookServer(fullDeps);
    server.start();
    return server;
  }

  describe('POST /reload', () => {
    it('calls reloadChannelMappings and returns 200', async () => {
      const reloadFn = vi.fn();
      startServer({ reloadChannelMappings: reloadFn });

      // Wait for server to start
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/reload', {});
      expect(res.status).toBe(200);
      expect(res.body).toBe('OK');
      expect(reloadFn).toHaveBeenCalledOnce();
    });
  });

  describe('POST /send-files', () => {
    it('returns 400 for missing projectName', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/send-files', { files: ['/tmp/f.png'] });
      expect(res.status).toBe(400);
      expect(res.body).toContain('projectName');
    });

    it('returns 400 for empty files array', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/send-files', { projectName: 'test', files: [] });
      expect(res.status).toBe(400);
      expect(res.body).toContain('No files');
    });

    it('returns 404 for unknown project', async () => {
      startServer({ stateManager: createMockStateManager({}) as any });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/send-files', { projectName: 'nonexistent', files: ['/tmp/f.png'] });
      expect(res.status).toBe(404);
      expect(res.body).toContain('Project not found');
    });

    it('returns 404 when no channel found for project', async () => {
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: {},
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({ stateManager: stateManager as any });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/send-files', { projectName: 'test', files: ['/tmp/f.png'] });
      expect(res.status).toBe(404);
      expect(res.body).toContain('No channel');
    });

    it('sends files for valid project with channelId', async () => {
      const filesDir = join(tempDir, '.discode', 'files');
      mkdirSync(filesDir, { recursive: true });
      const testFile = join(filesDir, 'test.png');
      writeFileSync(testFile, 'fake-png-data');

      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({ messaging: mockMessaging as any, stateManager: stateManager as any });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/send-files', {
        projectName: 'test',
        agentType: 'claude',
        files: [testFile],
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannelWithFiles).toHaveBeenCalledWith('ch-123', '', [testFile]);
    });

    it('rejects files outside the project directory', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({ messaging: mockMessaging as any, stateManager: stateManager as any });
      await new Promise((r) => setTimeout(r, 50));

      // File outside projectPath
      const outsideFile = join(realpathSync(tmpdir()), 'outside.txt');
      writeFileSync(outsideFile, 'outside');
      try {
        const res = await postJSON(port, '/send-files', {
          projectName: 'test',
          agentType: 'claude',
          files: [outsideFile],
        });
        expect(res.status).toBe(400);
        expect(res.body).toContain('No valid files');
      } finally {
        rmSync(outsideFile, { force: true });
      }
    });
  });

  describe('POST /opencode-event', () => {
    it('handles session.idle with text', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Hello from agent',
      });
      expect(res.status).toBe(200);
      expect(mockPendingTracker.markCompleted).toHaveBeenCalled();
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Hello from agent');
    });

    it('strips file paths from display text in session.idle', async () => {
      const filesDir = join(tempDir, '.discode', 'files');
      mkdirSync(filesDir, { recursive: true });
      const testFile = join(filesDir, 'output.png');
      writeFileSync(testFile, 'png-data');

      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const textWithPath = `Here is the output: ${testFile}`;
      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: textWithPath,
      });
      expect(res.status).toBe(200);

      // The sent text should not contain the file path
      const sentText = mockMessaging.sendToChannel.mock.calls[0]?.[1] || '';
      expect(sentText).not.toContain(testFile);
      expect(sentText).toContain('Here is the output:');

      // File should be sent separately
      expect(mockMessaging.sendToChannelWithFiles).toHaveBeenCalledWith('ch-123', '', [testFile]);
    });

    it('handles session.error', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.error',
        text: 'Something went wrong',
      });
      expect(res.status).toBe(200);
      expect(mockPendingTracker.markError).toHaveBeenCalled();
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
        'ch-123',
        expect.stringContaining('Something went wrong'),
      );
    });

    it('handles session.notification with permission_prompt', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'permission_prompt',
        text: 'Claude needs permission to use Bash',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
        'ch-123',
        expect.stringContaining('Claude needs permission to use Bash'),
      );
      // Should contain the lock emoji for permission_prompt
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toMatch(/^🔐/);
    });

    it('handles session.notification with idle_prompt', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'idle_prompt',
        text: 'Claude is idle',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toMatch(/^💤/);
    });

    it('handles session.notification with auth_success', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'auth_success',
        text: 'Auth succeeded',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toMatch(/^🔑/);
      expect(sentMsg).toContain('Auth succeeded');
    });

    it('handles session.notification with elicitation_dialog', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'elicitation_dialog',
        text: 'Claude wants to ask a question',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toMatch(/^❓/);
    });

    it('handles session.notification without text (falls back to notificationType)', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'permission_prompt',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toContain('permission_prompt');
    });

    it('handles session.notification without notificationType', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        text: 'Some notification',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      // Should use bell emoji for unknown type
      expect(sentMsg).toMatch(/^🔔/);
    });

    it('handles session.notification with both text and notificationType missing', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      // Bell emoji for unknown type, message falls back to notificationType "unknown"
      expect(sentMsg).toMatch(/^🔔/);
      expect(sentMsg).toContain('unknown');
    });

    it('handles session.notification with unknown type using bell emoji', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'some_new_type',
        text: 'New notification',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toMatch(/^🔔/);
    });

    it('sends promptText after notification message for session.notification', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'idle_prompt',
        text: 'Claude Code needs your attention',
        promptText: '❓ *Approach*\nWhich approach?\n• *Fast* — Quick\n• *Safe* — Reliable',
      });
      expect(res.status).toBe(200);
      // First call: the notification message itself
      expect(mockMessaging.sendToChannel.mock.calls[0][1]).toContain('Claude Code needs your attention');
      // Second call: the prompt details
      expect(mockMessaging.sendToChannel.mock.calls.length).toBeGreaterThanOrEqual(2);
      const promptMsg = mockMessaging.sendToChannel.mock.calls[1][1];
      expect(promptMsg).toContain('Which approach?');
      expect(promptMsg).toContain('*Fast*');
      expect(promptMsg).toContain('*Safe*');
    });

    it('does not send promptText when empty in session.notification', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'permission_prompt',
        text: 'Claude needs permission',
      });
      expect(res.status).toBe(200);
      // Only one message: the notification itself (no promptText)
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
      expect(mockMessaging.sendToChannel.mock.calls[0][1]).toContain('Claude needs permission');
    });

    it('does not send promptText when not a string in session.notification', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'idle_prompt',
        text: 'Notification',
        promptText: 12345,
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
    });

    it('sends ExitPlanMode promptText in session.notification', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'idle_prompt',
        text: 'Claude Code needs your attention',
        promptText: '📋 Plan approval needed',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mockMessaging.sendToChannel.mock.calls[1][1]).toContain('Plan approval needed');
    });

    it('does not send session.start message for startup source', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.start',
        source: 'startup',
        model: 'claude-sonnet-4-6',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    });

    it('handles session.start without model', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.start',
        source: 'resume',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toContain('resume');
      expect(sentMsg).not.toContain(',');
    });

    it('handles session.start without source (defaults to unknown)', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.start',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toContain('unknown');
      expect(sentMsg).not.toContain(',');
    });

    it('handles session.end event', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.end',
        reason: 'logout',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
        'ch-123',
        expect.stringContaining('Session ended'),
      );
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toContain('logout');
    });

    it('handles session.end without reason (defaults to unknown)', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.end',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toContain('unknown');
    });

    it('handles session.end with prompt_input_exit reason', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.end',
        reason: 'prompt_input_exit',
      });
      expect(res.status).toBe(200);
      const sentMsg = mockMessaging.sendToChannel.mock.calls[0][1];
      expect(sentMsg).toContain('prompt_input_exit');
    });

    it('handles thinking.start by adding brain reaction', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts');
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'thinking.start',
      });
      expect(res.status).toBe(200);
      expect(mockPendingTracker.ensureStartMessage).toHaveBeenCalled();
      expect(mockMessaging.addReactionToMessage).toHaveBeenCalledWith('ch-123', 'msg-user-1', '\uD83E\uDDE0');
    });

    it('handles thinking.start without pending message', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue(undefined);
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'thinking.start',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.addReactionToMessage).not.toHaveBeenCalled();
    });

    it('handles thinking.stop by replacing brain reaction', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'thinking.stop',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.replaceOwnReactionOnMessage).toHaveBeenCalledWith('ch-123', 'msg-user-1', '\uD83E\uDDE0', '\u2705');
    });

    it('handles session.idle with usage in finalize header', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const mockStreaming = createMockStreamingUpdater();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
        streamingUpdater: mockStreaming as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Done result',
        usage: { inputTokens: 5000, outputTokens: 3234, totalCostUsd: 0.03 },
      });
      expect(res.status).toBe(200);

      // Finalize should be called with custom header containing tokens and cost
      expect(mockStreaming.finalize).toHaveBeenCalledWith(
        'test',
        'claude',
        expect.stringContaining('Done'),
        'start-msg-ts',
      );
      const finalizeHeader = mockStreaming.finalize.mock.calls[0][2];
      expect(finalizeHeader).toContain('8,234');  // 5000 + 3234
      expect(finalizeHeader).toContain('$0.03');
    });

    it('handles session.idle with usage thread reply', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Result text',
        usage: { inputTokens: 5000, outputTokens: 3234, totalCostUsd: 0.03 },
      });
      expect(res.status).toBe(200);

      // Should post usage details as thread reply
      const threadCalls = mockMessaging.replyInThread.mock.calls;
      const usageReply = threadCalls.find((c: any[]) =>
        typeof c[2] === 'string' && c[2].includes('Input:'),
      );
      expect(usageReply).toBeDefined();
      expect(usageReply![2]).toContain('5,000');
      expect(usageReply![2]).toContain('3,234');
      expect(usageReply![2]).toContain('$0.03');
    });

    it('handles session.idle without usage (no custom finalize header)', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const mockStreaming = createMockStreamingUpdater();
      // Provide a live pending entry with startMessageId so finalize is called
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
        streamingUpdater: mockStreaming as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Simple result',
      });
      expect(res.status).toBe(200);

      // Finalize should be called WITHOUT custom header (no usage) but WITH startMessageId
      expect(mockStreaming.finalize).toHaveBeenCalledWith('test', 'claude', undefined, 'start-msg-ts');
    });

    it('posts thinking as thread reply on start message', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      // getPending returns startMessageId — the bot's "Processing..." message
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'The answer is 42',
        thinking: 'Let me reason about this question...',
      });
      expect(res.status).toBe(200);
      // Thinking should be posted as thread reply on the START message (not user's message)
      expect(mockMessaging.replyInThread).toHaveBeenCalledWith(
        'ch-123',
        'start-msg-ts',
        expect.stringContaining('Reasoning'),
      );
      expect(mockMessaging.replyInThread).toHaveBeenCalledWith(
        'ch-123',
        'start-msg-ts',
        expect.stringContaining('Let me reason about this question...'),
      );
      // Final response goes to channel (not thread)
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
    });

    it('wraps thinking content in code block', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Done',
        thinking: 'Step 1: read the file\nStep 2: fix the bug',
      });
      expect(res.status).toBe(200);
      const thinkingContent = mockMessaging.replyInThread.mock.calls
        .map((call: any) => call[2])
        .join('');
      // Header should be outside the code block
      expect(thinkingContent).toContain(':brain: *Reasoning*');
      // Thinking text should be inside triple-backtick code block
      expect(thinkingContent).toContain('```\nStep 1: read the file\nStep 2: fix the bug\n```');
      // Response text goes to channel
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Done');
    });

    it('wraps truncated thinking in code block with truncation marker outside', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const longThinking = 'y'.repeat(15000);
      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Done',
        thinking: longThinking,
      });
      expect(res.status).toBe(200);
      const thinkingContent = mockMessaging.replyInThread.mock.calls
        .map((call: any) => call[2])
        .join('');
      // Should contain opening and closing code fences
      expect(thinkingContent).toContain('```\n');
      expect(thinkingContent).toContain('\n```');
      // Truncation marker should be present inside the code block
      expect(thinkingContent).toContain('_(truncated)_');
      // Response text goes to channel
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Done');
    });

    it('does not post thinking when no startMessageId', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      // getPending returns entry WITHOUT startMessageId (sendToChannelWithId failed)
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'The answer is 42',
        thinking: 'Some thinking...',
      });
      expect(res.status).toBe(200);
      // Should NOT post thinking (no startMessageId to thread on)
      expect(mockMessaging.replyInThread).not.toHaveBeenCalled();
      // Should still post the main response
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
    });

    it('does not post thinking when no pending message', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      // getPending returns undefined (no pending message at all)
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'The answer is 42',
        thinking: 'Some thinking...',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.replyInThread).not.toHaveBeenCalled();
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
    });

    it('does not post empty thinking', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'The answer is 42',
      });
      expect(res.status).toBe(200);
      // No thinking posted (empty), so replyInThread should not be called
      expect(mockMessaging.replyInThread).not.toHaveBeenCalled();
      // Response text goes through sendToChannel
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
    });

    it('truncates long thinking content', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const longThinking = 'x'.repeat(15000);
      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Done',
        thinking: longThinking,
      });
      expect(res.status).toBe(200);
      // Collect all thread reply content
      const allThinkingContent = mockMessaging.replyInThread.mock.calls
        .map((call: any) => call[2])
        .join('');
      expect(allThinkingContent).toContain('Reasoning');
      expect(allThinkingContent).toContain('_(truncated)_');
      expect(allThinkingContent.length).toBeLessThan(15000);
    });

    it('does not post whitespace-only thinking', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'The answer is 42',
        thinking: '   \n  ',
      });
      expect(res.status).toBe(200);
      // No thinking posted (whitespace-only), so replyInThread should not be called
      expect(mockMessaging.replyInThread).not.toHaveBeenCalled();
      // Response text goes through sendToChannel
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
    });

    it('does not post thinking when thinking is not a string', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'The answer is 42',
        thinking: 12345,
      });
      expect(res.status).toBe(200);
      // No thinking posted (not a string), so replyInThread should not be called
      expect(mockMessaging.replyInThread).not.toHaveBeenCalled();
      // Response text goes through sendToChannel
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
    });

    it('splits long thinking into multiple thread replies', async () => {
      const mockMessaging = createMockMessaging();
      // Slack platform — limit is ~3900 chars per message
      mockMessaging.platform = 'slack' as const;
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Generate thinking with newlines that exceeds Slack's ~3900 char limit
      const lines = Array.from({ length: 80 }, (_, i) => `Reasoning step ${i}: ${'x'.repeat(60)}`);
      const longThinking = lines.join('\n');
      expect(longThinking.length).toBeGreaterThan(3900);

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Done',
        thinking: longThinking,
      });
      expect(res.status).toBe(200);
      // Should be split into at least 2 thread replies
      expect(mockMessaging.replyInThread.mock.calls.length).toBeGreaterThanOrEqual(2);
      // All replies should target the start message
      for (const call of mockMessaging.replyInThread.mock.calls) {
        expect(call[0]).toBe('ch-123');
        expect(call[1]).toBe('start-msg-ts');
      }
    });

    it('uses Discord splitting for discord platform thinking', async () => {
      const mockMessaging = createMockMessaging();
      mockMessaging.platform = 'discord' as const;
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Discord limit is ~1900 chars. Create thinking between 1900-3900 to verify Discord splitting (not Slack).
      const thinking = 'x'.repeat(2500);
      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Done',
        thinking,
      });
      expect(res.status).toBe(200);
      // With Discord splitting (1900 limit) + header, should need multiple chunks
      expect(mockMessaging.replyInThread.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('does not post thinking when replyInThread method is absent', async () => {
      const mockMessaging = createMockMessaging();
      // Remove replyInThread to simulate a client that doesn't support it
      delete (mockMessaging as any).replyInThread;
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'The answer is 42',
        thinking: 'Some thinking...',
      });
      expect(res.status).toBe(200);
      // Main response should still be sent
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
    });

    it('calls getPending before markCompleted to preserve startMessageId', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const callOrder: string[] = [];
      mockPendingTracker.getPending.mockImplementation(() => {
        callOrder.push('getPending');
        return { channelId: 'ch-123', messageId: 'msg-user-1', startMessageId: 'start-msg-ts' };
      });
      mockPendingTracker.markCompleted.mockImplementation(async () => {
        callOrder.push('markCompleted');
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Done',
        thinking: 'Thought about it',
      });

      // getPending must be called before markCompleted
      expect(callOrder.indexOf('getPending')).toBeLessThan(callOrder.indexOf('markCompleted'));
    });

    it('sends thinking and main response to correct channels independently', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'The final answer',
        thinking: 'Internal reasoning',
      });
      expect(res.status).toBe(200);

      // Thinking goes to thread via replyInThread
      expect(mockMessaging.replyInThread).toHaveBeenCalled();
      const threadCalls = mockMessaging.replyInThread.mock.calls;
      for (const call of threadCalls) {
        expect(call[1]).toBe('start-msg-ts'); // thread parent is start message
      }

      // Main response goes to channel via sendToChannel
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The final answer');
    });

    it('handles replyInThread failure gracefully', async () => {
      const mockMessaging = createMockMessaging();
      mockMessaging.replyInThread.mockRejectedValue(new Error('Slack API error'));
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'The answer is 42',
        thinking: 'Some thinking...',
      });
      // Response text goes through sendToChannel (not replyInThread), so replyInThread failure
      // only affects thinking which is try/caught — request succeeds with 200
      expect(res.status).toBe(200);
      // Response text is delivered via sendToChannel
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'The answer is 42');
    });

    it('returns 400 for missing projectName', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', { type: 'session.idle' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid JSON body', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await postRaw(port, '/opencode-event', 'not valid json');
      expect(res.status).toBe(400);
      expect(res.body).toContain('Invalid JSON');
    });

    it('returns 400 for non-object payload', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await postRaw(port, '/opencode-event', '"just a string"');
      expect(res.status).toBe(400);
      expect(res.body).toContain('Invalid event payload');
    });

    it('returns 400 for unknown project', async () => {
      startServer({ stateManager: createMockStateManager({}) as any });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'nonexistent',
        agentType: 'claude',
        type: 'session.idle',
        text: 'hello',
      });
      expect(res.status).toBe(400);
    });

    it('prefers text over message field in getEventText', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'from text field',
        message: 'from message field',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'from text field');
    });

    it('falls back to message field when text is missing', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        message: 'fallback message',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'fallback message');
    });

    it('handles session.error without text (defaults to "unknown error")', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.error',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
        'ch-123',
        expect.stringContaining('unknown error'),
      );
    });

    it('handles session.idle with empty text (no message sent)', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    });

    it('handles unknown event type gracefully', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'some.future.event',
        text: 'hello',
      });
      // Unknown event types still return 200 (true) per the catch-all return
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    });

    it('uses turnText for file path extraction when text has no paths', async () => {
      const filesDir = join(tempDir, '.discode', 'files');
      mkdirSync(filesDir, { recursive: true });
      const testFile = join(filesDir, 'output.png');
      writeFileSync(testFile, 'fake-png');

      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Here is the chart',
        turnText: `Created ${testFile}`,
      });
      expect(res.status).toBe(200);
      // Text message should be sent
      expect(mockMessaging.sendToChannel).toHaveBeenCalled();
      // File from turnText should be sent
      expect(mockMessaging.sendToChannelWithFiles).toHaveBeenCalledWith('ch-123', '', [testFile]);
    });

    it('sends promptText as additional message after response text', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Which approach?',
        promptText: '❓ *Approach*\nWhich approach?\n\n• *Fast* — Quick\n• *Safe* — Reliable',
      });
      expect(res.status).toBe(200);
      // First call: response text, second call: prompt text
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(2);
      expect(mockMessaging.sendToChannel.mock.calls[0][1]).toBe('Which approach?');
      expect(mockMessaging.sendToChannel.mock.calls[1][1]).toContain('*Approach*');
      expect(mockMessaging.sendToChannel.mock.calls[1][1]).toContain('*Fast*');
    });

    it('does not send extra message when promptText is empty', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Hello from agent',
        promptText: '',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
      expect(mockMessaging.sendToChannel.mock.calls[0][1]).toBe('Hello from agent');
    });

    it('uses Discord splitting for promptText on discord platform', async () => {
      const mockMessaging = createMockMessaging();
      mockMessaging.platform = 'discord' as const;
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Create promptText > 1900 chars (Discord limit) to trigger splitting
      const lines = Array.from({ length: 40 }, (_, i) => `• *Option ${i}* — ${'x'.repeat(40)}`);
      const longPrompt = `❓ *Big question*\nPick one?\n${lines.join('\n')}`;
      expect(longPrompt.length).toBeGreaterThan(1900);

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Choose one',
        promptText: longPrompt,
      });
      expect(res.status).toBe(200);
      // First call: response text, subsequent calls: split promptText chunks
      expect(mockMessaging.sendToChannel.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(mockMessaging.sendToChannel.mock.calls[0][1]).toBe('Choose one');
    });

    it('does not send promptText that is whitespace only', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Hello',
        promptText: '   \n  ',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
      expect(mockMessaging.sendToChannel.mock.calls[0][1]).toBe('Hello');
    });

    it('sends thinking + text + promptText in correct order', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Here are options.',
        thinking: 'Analyzing requirements...',
        promptText: '❓ Pick an approach?',
      });
      expect(res.status).toBe(200);

      // Thinking → thread reply
      expect(mockMessaging.replyInThread).toHaveBeenCalledWith(
        'ch-123',
        'start-msg-ts',
        expect.stringContaining('Analyzing requirements'),
      );
      // Text and promptText → channel messages
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Here are options.');
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
        'ch-123',
        expect.stringContaining('Pick an approach?'),
      );
    });

    it('sends promptText with files in correct order', async () => {
      const filesDir = join(tempDir, '.discode', 'files');
      mkdirSync(filesDir, { recursive: true });
      const testFile = join(filesDir, 'diagram.png');
      writeFileSync(testFile, 'png-data');

      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: `Here is the diagram: ${testFile}`,
        turnText: `Created ${testFile}`,
        promptText: '❓ Does this look correct?',
      });
      expect(res.status).toBe(200);

      // Text (with file path stripped) → channel message
      const sentText = mockMessaging.sendToChannel.mock.calls[0]?.[1] || '';
      expect(sentText).not.toContain(testFile);
      // Files sent
      expect(mockMessaging.sendToChannelWithFiles).toHaveBeenCalledWith('ch-123', '', [testFile]);
      // PromptText → additional channel message
      const lastCall = mockMessaging.sendToChannel.mock.calls[mockMessaging.sendToChannel.mock.calls.length - 1];
      expect(lastCall[1]).toContain('Does this look correct?');
    });

    it('does not send promptText when type is not string', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Hello',
        promptText: 12345,
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
      expect(mockMessaging.sendToChannel.mock.calls[0][1]).toBe('Hello');
    });

    it('posts tool.activity as thread reply and appends subsequent ones', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts');
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // First tool.activity creates thread reply via replyInThreadWithId
      const res1 = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });
      expect(res1.status).toBe(200);
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledTimes(1);
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledWith(
        'ch-123',
        'start-msg-ts',
        '📖 Read(`src/index.ts`)',
      );

      // Second tool.activity updates the same thread message
      const res2 = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '✏️ Edit(`src/config.ts`)',
      });
      expect(res2.status).toBe(200);
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledTimes(1); // no new thread reply
      expect(mockMessaging.updateMessage).toHaveBeenCalledWith(
        'ch-123',
        'thread-msg-ts',
        '📖 Read(`src/index.ts`)\n✏️ Edit(`src/config.ts`)',
      );
      // tool.activity should not send channel messages
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    });

    it('tool.activity thread reply accumulates activities after multiple updates', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts');
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // First tool.activity creates thread reply
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/a.ts`)',
      });

      // Second tool.activity appends to thread message
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/b.ts`)',
      });

      // Third tool.activity appends to thread message again
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '✏️ Edit(`src/c.ts`)',
      });

      // Only one thread reply should be created
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledTimes(1);
      // updateMessage called twice (2nd and 3rd activity)
      expect(mockMessaging.updateMessage).toHaveBeenCalledTimes(2);
      // Each call appends to accumulated lines
      expect(mockMessaging.updateMessage).toHaveBeenNthCalledWith(1,
        'ch-123', 'thread-msg-ts', '📖 Read(`src/a.ts`)\n📖 Read(`src/b.ts`)');
      expect(mockMessaging.updateMessage).toHaveBeenNthCalledWith(2,
        'ch-123', 'thread-msg-ts', '📖 Read(`src/a.ts`)\n📖 Read(`src/b.ts`)\n✏️ Edit(`src/c.ts`)');
    });

    it('tool.activity thread reply accumulates all previous activity text', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts');
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Send 5 rapid tool activities
      const activities = [
        '📖 Read(`src/one.ts`)',
        '📖 Read(`src/two.ts`)',
        '✏️ Edit(`src/three.ts`)',
        '📖 Read(`src/four.ts`)',
        '💻 `npm test`',
      ];
      for (const text of activities) {
        await postJSON(port, '/opencode-event', {
          projectName: 'test',
          agentType: 'claude',
          type: 'tool.activity',
          text,
        });
      }

      // Last updateMessage call should contain all accumulated activities
      const lastCall = mockMessaging.updateMessage.mock.calls[mockMessaging.updateMessage.mock.calls.length - 1];
      expect(lastCall[2]).toBe(activities.join('\n'));
    });

    it('tool.activity thread accumulation includes first message from replyInThreadWithId', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts');
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // First activity → replyInThreadWithId
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/a.ts`)',
      });

      // Second activity → updateMessage with BOTH lines
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '✏️ Edit(`src/b.ts`)',
      });

      expect(mockMessaging.updateMessage).toHaveBeenCalledTimes(1);
      const content = mockMessaging.updateMessage.mock.calls[0][2];
      // Must include the first activity line (from replyInThreadWithId) + second
      expect(content).toBe('📖 Read(`src/a.ts`)\n✏️ Edit(`src/b.ts`)');
    });

    it('tool.activity thread updateMessage failure preserves accumulated lines', async () => {
      const mockMessaging = createMockMessaging();
      mockMessaging.updateMessage.mockRejectedValueOnce(new Error('API error'));
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts');
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // First activity → creates thread
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/a.ts`)',
      });

      // Second activity → updateMessage fails
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '✏️ Edit(`src/b.ts`)',
      });

      // Third activity → should still have all 3 lines despite previous failure
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '💻 `npm test`',
      });

      // The third call (second updateMessage) should contain all 3 accumulated lines
      expect(mockMessaging.updateMessage).toHaveBeenCalledTimes(2);
      expect(mockMessaging.updateMessage).toHaveBeenLastCalledWith(
        'ch-123', 'thread-msg-ts',
        '📖 Read(`src/a.ts`)\n✏️ Edit(`src/b.ts`)\n💻 `npm test`',
      );
    });

    it('replyInThreadWithId null then success starts fresh accumulation', async () => {
      const mockMessaging = createMockMessaging();
      // First call returns null, second succeeds
      mockMessaging.replyInThreadWithId
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('retry-msg-ts');
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts');
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // First activity — fails (null return), no map entry
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/a.ts`)',
      });

      // Second activity — retry succeeds, creates fresh entry
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '✏️ Edit(`src/b.ts`)',
      });

      // Third activity — appends to the entry created by second
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '💻 `npm test`',
      });

      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledTimes(2);
      // updateMessage should have accumulated only from the retry onwards (not the failed first)
      expect(mockMessaging.updateMessage).toHaveBeenCalledTimes(1);
      expect(mockMessaging.updateMessage).toHaveBeenCalledWith(
        'ch-123', 'retry-msg-ts',
        '✏️ Edit(`src/b.ts`)\n💻 `npm test`',
      );
    });

    it('session.idle resets thread accumulation — next session starts with empty lines', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts');
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Session 1: two activities accumulate
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/a.ts`)',
      });
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '✏️ Edit(`src/b.ts`)',
      });
      expect(mockMessaging.updateMessage).toHaveBeenLastCalledWith(
        'ch-123', 'thread-msg-ts',
        '📖 Read(`src/a.ts`)\n✏️ Edit(`src/b.ts`)');

      // session.idle clears thread tracking
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Done',
      });

      // Session 2: new pending with new startMessageId
      mockMessaging.replyInThreadWithId.mockClear();
      mockMessaging.updateMessage.mockClear();
      mockMessaging.replyInThreadWithId.mockResolvedValue('new-thread-ts');
      mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts-2');
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-2',
        startMessageId: 'start-msg-ts-2',
      });

      // New session activities start fresh
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/new.ts`)',
      });
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '✏️ Edit(`src/new.ts`)',
      });

      // New thread created fresh (not carrying old lines)
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledTimes(1);
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledWith(
        'ch-123', 'start-msg-ts-2', '📖 Read(`src/new.ts`)');
      expect(mockMessaging.updateMessage).toHaveBeenCalledTimes(1);
      // Only new session lines, no old ones
      expect(mockMessaging.updateMessage).toHaveBeenCalledWith(
        'ch-123', 'new-thread-ts',
        '📖 Read(`src/new.ts`)\n✏️ Edit(`src/new.ts`)');
    });

    it('stale parentMessageId starts fresh accumulation for new thread', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts-1');
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts-1',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Session 1: accumulate 2 lines
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/old.ts`)',
      });
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '✏️ Edit(`src/old.ts`)',
      });

      // Pending switches to new startMessageId (new request overwrites)
      mockMessaging.replyInThreadWithId.mockClear();
      mockMessaging.updateMessage.mockClear();
      mockMessaging.replyInThreadWithId.mockResolvedValue('new-thread-ts');
      mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts-2');
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-2',
        startMessageId: 'start-msg-ts-2',
      });

      // New request: parentMessageId mismatch forces fresh thread
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/new.ts`)',
      });
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '✏️ Edit(`src/new.ts`)',
      });

      // Fresh thread created for new parent
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledTimes(1);
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledWith(
        'ch-123', 'start-msg-ts-2', '📖 Read(`src/new.ts`)');
      // Accumulated from fresh start only
      expect(mockMessaging.updateMessage).toHaveBeenCalledTimes(1);
      expect(mockMessaging.updateMessage).toHaveBeenCalledWith(
        'ch-123', 'new-thread-ts',
        '📖 Read(`src/new.ts`)\n✏️ Edit(`src/new.ts`)');
    });

    it('ignores tool.activity when no pending entry', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      // getPending returns undefined (no pending entry)
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.replyInThreadWithId).not.toHaveBeenCalled();
    });

    it('ignores tool.activity when text is empty', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.replyInThreadWithId).not.toHaveBeenCalled();
    });

    it('ignores tool.activity when no startMessageId', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        // no startMessageId
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.replyInThreadWithId).not.toHaveBeenCalled();
    });

    it('handles tool.activity replyInThreadWithId failure gracefully', async () => {
      const mockMessaging = createMockMessaging();
      mockMessaging.replyInThreadWithId.mockRejectedValue(new Error('Slack API error'));
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Should not crash — failure is caught
      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });
      expect(res.status).toBe(200);
    });

    it('ignores tool.activity when thread reply methods are absent', async () => {
      const mockMessaging = createMockMessaging();
      delete (mockMessaging as any).replyInThread;
      delete (mockMessaging as any).replyInThreadWithId;
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });
      expect(res.status).toBe(200);
      // No crash, no channel message sent
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    });

    it('replyInThreadWithId returning null skips map entry — next activity retries thread creation', async () => {
      const mockMessaging = createMockMessaging();
      // First call returns null (e.g. API error returned falsy), second returns valid ID
      mockMessaging.replyInThreadWithId
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('retry-msg-ts');
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts');
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // First activity — replyInThreadWithId returns null, map entry NOT created
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/a.ts`)',
      });
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledTimes(1);

      // Second activity — since map entry doesn't exist, should retry replyInThreadWithId (not updateMessage)
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '✏️ Edit(`src/b.ts`)',
      });
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledTimes(2);
      expect(mockMessaging.updateMessage).not.toHaveBeenCalled();
    });

    it('session.error clears threadActivityMessages — next session starts fresh', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts');
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // First: tool.activity creates thread entry
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledTimes(1);

      // session.error should clear the threadActivityMessages map
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.error',
        text: 'crash',
      });

      // Reset mocks and set new pending for next session
      mockMessaging.replyInThreadWithId.mockClear();
      mockMessaging.updateMessage.mockClear();
      mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts-2');
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-2',
        startMessageId: 'start-msg-ts-2',
      });

      // Next tool.activity should create NEW thread (replyInThreadWithId), not update old one
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/other.ts`)',
      });
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledTimes(1);
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledWith(
        'ch-123',
        'start-msg-ts-2',
        '📖 Read(`src/other.ts`)',
      );
      // Should NOT call updateMessage (that would mean it tried to append to old thread)
      expect(mockMessaging.updateMessage).not.toHaveBeenCalled();
    });

    it('session.idle clears threadActivityMessages — next session starts fresh', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts');
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // tool.activity creates thread entry
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });

      // session.idle clears threadActivityMessages
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Done',
      });

      // Reset mocks and set new pending for next session
      mockMessaging.replyInThreadWithId.mockClear();
      mockMessaging.updateMessage.mockClear();
      mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts-2');
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-2',
        startMessageId: 'start-msg-ts-2',
      });

      // Next tool.activity should create a NEW thread, not update old one
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '✏️ Edit(`src/new.ts`)',
      });
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledTimes(1);
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledWith(
        'ch-123',
        'start-msg-ts-2',
        '✏️ Edit(`src/new.ts`)',
      );
      expect(mockMessaging.updateMessage).not.toHaveBeenCalled();
    });

    it('stale parentMessageId guard: new request creates fresh thread instead of appending', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts-1');
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts-1',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // First request: tool.activity creates thread entry for start-msg-ts-1
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/a.ts`)',
      });
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledTimes(1);

      // Simulate a new request arriving: pending now points to a different startMessageId
      mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts-2');
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-2',
        startMessageId: 'start-msg-ts-2',
      });

      // Second tool.activity with NEW startMessageId — should NOT use updateMessage on old thread
      // Instead should call replyInThreadWithId for the new parent
      mockMessaging.replyInThreadWithId.mockResolvedValueOnce('new-thread-msg-ts');
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '✏️ Edit(`src/b.ts`)',
      });
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledTimes(2);
      expect(mockMessaging.replyInThreadWithId).toHaveBeenLastCalledWith(
        'ch-123',
        'start-msg-ts-2',
        '✏️ Edit(`src/b.ts`)',
      );
      // Should NOT have called updateMessage to append to old thread
      expect(mockMessaging.updateMessage).not.toHaveBeenCalled();
    });

    it('tool.activity does not call markCompleted', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });
      // tool.activity should NOT call markCompleted — only session.idle does
      expect(mockPendingTracker.markCompleted).not.toHaveBeenCalled();
    });

    it('tool.activity uses text from message field as fallback', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts');
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        message: '💻 `npm test`',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledWith(
        'ch-123',
        'start-msg-ts',
        '💻 `npm test`',
      );
    });

    it('session.idle no longer processes toolSummary field', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Done!',
        toolSummary: '📖 Read(`src/index.ts`)',
      });
      // toolSummary is no longer handled in session.idle — should NOT appear as thread reply
      const threadCalls = mockMessaging.replyInThread.mock.calls;
      const hasActivity = threadCalls.some((c: any) => c[2].includes('Activity'));
      expect(hasActivity).toBe(false);
    });

    it('posts intermediateText as thread reply', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Final response',
        intermediateText: '현재 분석 인프라를 파악하겠습니다.',
      });
      const threadCalls = mockMessaging.replyInThread.mock.calls;
      expect(threadCalls.some((c: any) => c[2] === '현재 분석 인프라를 파악하겠습니다.')).toBe(true);
    });

    it('does not post intermediateText when empty', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Response only',
        intermediateText: '',
      });
      const threadCalls = mockMessaging.replyInThread.mock.calls;
      // No intermediateText or thinking, and response text goes through sendToChannel, so no thread calls
      expect(threadCalls.length).toBe(0);
      // Response text goes through sendToChannel
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Response only');
    });

    it('posts intermediateText before thinking in thread', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Final answer',
        intermediateText: 'Let me check the code.',
        thinking: 'Reasoning about the problem...',
      });
      const threadCalls = mockMessaging.replyInThread.mock.calls;
      // intermediateText should come before thinking (both in thread)
      const intermediateIdx = threadCalls.findIndex((c: any) => c[2] === 'Let me check the code.');
      const thinkingIdx = threadCalls.findIndex((c: any) => c[2].includes('Reasoning'));
      expect(intermediateIdx).toBeGreaterThanOrEqual(0);
      expect(thinkingIdx).toBeGreaterThanOrEqual(0);
      expect(intermediateIdx).toBeLessThan(thinkingIdx);
      // Response text goes to channel
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Final answer');
    });

    it('auto-creates pending entry for tmux-initiated tool.activity', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      // No pending entry — simulating tmux-initiated prompt
      mockPendingTracker.hasPending.mockReturnValue(false);
      mockPendingTracker.ensurePending = vi.fn().mockImplementation(async () => {
        // After ensurePending, getPending returns a new entry (without startMessageId)
        mockPendingTracker.getPending.mockReturnValue({
          channelId: 'ch-123',
          messageId: '',
        });
      });
      // ensureStartMessage lazily creates the start message
      mockPendingTracker.ensureStartMessage.mockResolvedValue('auto-start-msg');
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });

      expect(mockPendingTracker.ensurePending).toHaveBeenCalledWith('test', 'claude', 'ch-123', 'claude');
      expect(mockPendingTracker.ensureStartMessage).toHaveBeenCalled();
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledWith('ch-123', 'auto-start-msg', '📖 Read(`src/index.ts`)');
    });

    it('auto-creates pending entry for tmux-initiated session.idle', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.hasPending.mockReturnValue(false);
      mockPendingTracker.ensurePending = vi.fn().mockImplementation(async () => {
        mockPendingTracker.getPending.mockReturnValue({
          channelId: 'ch-123',
          messageId: '',
          startMessageId: 'auto-start-msg',
        });
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Response from tmux',
      });

      expect(mockPendingTracker.ensurePending).toHaveBeenCalledWith('test', 'claude', 'ch-123', 'claude');
      // Response text goes through sendToChannel (not replyInThread)
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Response from tmux');
    });

    it('does not call ensurePending when pending already exists', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.hasPending.mockReturnValue(true);
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      mockPendingTracker.ensurePending = vi.fn();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });

      expect(mockPendingTracker.ensurePending).not.toHaveBeenCalled();
    });

    it('does not call ensurePending for session.notification', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.hasPending.mockReturnValue(false);
      mockPendingTracker.ensurePending = vi.fn();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.notification',
        notificationType: 'permission_prompt',
        text: 'Allow?',
      });

      expect(mockPendingTracker.ensurePending).not.toHaveBeenCalled();
    });

    it('does not call ensurePending for session.error', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.hasPending.mockReturnValue(false);
      mockPendingTracker.ensurePending = vi.fn();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.error',
        text: 'Something broke',
      });

      expect(mockPendingTracker.ensurePending).not.toHaveBeenCalled();
    });

    it('session.end calls setHookActive on pending tracker', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.end',
        reason: 'model',
      });

      expect(mockPendingTracker.setHookActive).toHaveBeenCalledWith('test', 'claude', 'claude');
    });

    it('session.start calls setHookActive on pending tracker', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.start',
        source: 'model',
        model: 'opus',
      });

      expect(mockPendingTracker.setHookActive).toHaveBeenCalledWith('test', 'claude', 'claude');
    });

    it('session.start lifecycle timer resolves pending after 5s with no AI activity', async () => {
      vi.useFakeTimers();
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.hasPending.mockReturnValue(true);
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-1',
        // no startMessageId — no AI activity happened
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });

      // Create server directly (not via HTTP) so we can use fake timers
      const hookServer = new BridgeHookServer({
        port: 0,
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
        streamingUpdater: createMockStreamingUpdater() as any,
        reloadChannelMappings: vi.fn(),
      });

      await hookServer.handleOpencodeEvent({
        projectName: 'test',
        agentType: 'claude',
        type: 'session.start',
        source: 'model',
        model: 'opus',
      });

      // Timer hasn't fired yet
      expect(mockPendingTracker.markCompleted).not.toHaveBeenCalled();

      // Advance past 5s lifecycle delay
      vi.advanceTimersByTime(5001);

      expect(mockPendingTracker.markCompleted).toHaveBeenCalledWith('test', 'claude', 'claude');

      hookServer.stop();
      vi.useRealTimers();
    });

    it('session.start lifecycle timer does NOT resolve when AI activity started (startMessageId set)', async () => {
      vi.useFakeTimers();
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.hasPending.mockReturnValue(true);
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-1',
        startMessageId: 'start-msg-ts', // AI activity started
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });

      const hookServer = new BridgeHookServer({
        port: 0,
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
        streamingUpdater: createMockStreamingUpdater() as any,
        reloadChannelMappings: vi.fn(),
      });

      await hookServer.handleOpencodeEvent({
        projectName: 'test',
        agentType: 'claude',
        type: 'session.start',
        source: 'model',
        model: 'opus',
      });

      vi.advanceTimersByTime(5001);

      // Should NOT mark completed because startMessageId exists (AI activity)
      expect(mockPendingTracker.markCompleted).not.toHaveBeenCalled();

      hookServer.stop();
      vi.useRealTimers();
    });

    it('thinking.start cancels session lifecycle timer', async () => {
      vi.useFakeTimers();
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.hasPending.mockReturnValue(true);
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-1',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });

      const hookServer = new BridgeHookServer({
        port: 0,
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
        streamingUpdater: createMockStreamingUpdater() as any,
        reloadChannelMappings: vi.fn(),
      });

      // Start session
      await hookServer.handleOpencodeEvent({
        projectName: 'test',
        agentType: 'claude',
        type: 'session.start',
        source: 'api',
      });

      // AI thinking starts (should cancel lifecycle timer)
      await hookServer.handleOpencodeEvent({
        projectName: 'test',
        agentType: 'claude',
        type: 'thinking.start',
      });

      // Advance past lifecycle delay — should NOT fire
      vi.advanceTimersByTime(5001);

      expect(mockPendingTracker.markCompleted).not.toHaveBeenCalled();

      hookServer.stop();
      vi.useRealTimers();
    });

    it('tool.activity cancels session lifecycle timer', async () => {
      vi.useFakeTimers();
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.hasPending.mockReturnValue(true);
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-1',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });

      const hookServer = new BridgeHookServer({
        port: 0,
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
        streamingUpdater: createMockStreamingUpdater() as any,
        reloadChannelMappings: vi.fn(),
      });

      // Start session
      await hookServer.handleOpencodeEvent({
        projectName: 'test',
        agentType: 'claude',
        type: 'session.start',
        source: 'api',
      });

      // Tool activity starts (should cancel lifecycle timer)
      await hookServer.handleOpencodeEvent({
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: 'Reading file...',
      });

      // Advance past lifecycle delay — should NOT fire
      vi.advanceTimersByTime(5001);

      expect(mockPendingTracker.markCompleted).not.toHaveBeenCalled();

      hookServer.stop();
      vi.useRealTimers();
    });

    it('does not call ensurePending for session.start', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.hasPending.mockReturnValue(false);
      mockPendingTracker.ensurePending = vi.fn();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.start',
        source: 'tmux',
      });

      expect(mockPendingTracker.ensurePending).not.toHaveBeenCalled();
    });

    it('ignores intermediateText when not a string', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Response',
        intermediateText: 42,
      });

      // intermediateText is not a string — should not appear as thread reply
      const threadCalls = mockMessaging.replyInThread.mock.calls;
      expect(threadCalls.every((c: any) => typeof c[2] === 'string' && !c[2].includes('42'))).toBe(true);
    });

    it('skips intermediateText when no startMessageId', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        // no startMessageId
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Response',
        intermediateText: 'Should not appear',
      });

      expect(mockMessaging.replyInThread).not.toHaveBeenCalled();
    });

    it('handles intermediateText replyInThread failure gracefully', async () => {
      const mockMessaging = createMockMessaging();
      mockMessaging.replyInThread.mockRejectedValue(new Error('Slack API error'));
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Still delivered',
        intermediateText: 'This fails to post',
      });

      // Response text goes through sendToChannel (not replyInThread), so replyInThread failure
      // only affects intermediateText which is try/caught — request succeeds with 200
      expect(res.status).toBe(200);
      // Response text is delivered via sendToChannel
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Still delivered');
    });

    it('skips intermediateText when replyInThread method is absent', async () => {
      const mockMessaging = createMockMessaging();
      delete (mockMessaging as any).replyInThread;
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Response',
        intermediateText: 'No thread support',
      });

      expect(res.status).toBe(200);
      // Main text should still be sent to channel
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Response');
    });

    it('sends promptText even when text is empty', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        promptText: '📋 Plan approval needed',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
      expect(mockMessaging.sendToChannel.mock.calls[0][1]).toContain('Plan approval needed');
    });

    it('skips empty text chunks', async () => {
      const mockMessaging = createMockMessaging();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: '   ',
      });
      expect(res.status).toBe(200);
      // No message should be sent for whitespace-only text
      expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    });

    it('uses Slack splitting for slack platform', async () => {
      const mockMessaging = createMockMessaging();
      mockMessaging.platform = 'slack' as const;
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: createMockPendingTracker() as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Create a message that's > 1900 chars (Discord limit) but < 3900 (Slack limit)
      const longText = 'x'.repeat(2500);
      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: longText,
      });
      expect(res.status).toBe(200);
      // With Slack splitting (3900 limit), the message should be sent as a single chunk
      expect(mockMessaging.sendToChannel).toHaveBeenCalledTimes(1);
    });

    // ── Streaming message updater integration ────────────────────────

    it('tool.activity posts as thread reply', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts');
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const mockStreaming = createMockStreamingUpdater();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
        streamingUpdater: mockStreaming as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });
      expect(res.status).toBe(200);
      // ensureStartMessage lazily creates the start message
      expect(mockPendingTracker.ensureStartMessage).toHaveBeenCalled();
      // Streaming updater started via ensureStartMessageAndStreaming
      expect(mockStreaming.start).toHaveBeenCalledWith('test', 'claude', 'ch-123', 'start-msg-ts');
      // Tool activity goes to thread AND streaming updater (parent message preview)
      expect(mockStreaming.append).toHaveBeenCalledWith('test', 'claude', '📖 Read(`src/index.ts`)');
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledWith(
        'ch-123',
        'start-msg-ts',
        '📖 Read(`src/index.ts`)',
      );
    });

    it('tool.activity skips thread reply when no pending startMessageId', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        // No startMessageId
      });
      const mockStreaming = createMockStreamingUpdater();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
        streamingUpdater: mockStreaming as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });
      expect(res.status).toBe(200);
      expect(mockMessaging.replyInThreadWithId).not.toHaveBeenCalled();
      // Streaming updater still receives the append (even without thread reply)
      expect(mockStreaming.append).toHaveBeenCalledWith('test', 'claude', '📖 Read(`src/index.ts`)');
    });

    it('session.idle calls streamingUpdater.finalize', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const mockStreaming = createMockStreamingUpdater();
      // Provide a live pending entry with startMessageId (simulating prior activity)
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
        startMessageId: 'start-msg-ts',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
        streamingUpdater: mockStreaming as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Done!',
      });

      expect(mockStreaming.finalize).toHaveBeenCalledWith('test', 'claude', undefined, 'start-msg-ts');
    });

    it('session.idle without prior activity skips streamingUpdater.finalize', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const mockStreaming = createMockStreamingUpdater();
      // No startMessageId in live pending — simulates no prior activity (thinking/tool events)
      mockPendingTracker.getPending.mockReturnValue({
        channelId: 'ch-123',
        messageId: 'msg-user-1',
      });
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
        streamingUpdater: mockStreaming as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Quick response',
      });

      // No startMessageId means no prior activity — finalize should NOT be called
      expect(mockStreaming.finalize).not.toHaveBeenCalled();
      // Response text should still be delivered
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Quick response');
      // markCompleted should still be called
      expect(mockPendingTracker.markCompleted).toHaveBeenCalled();
    });

    it('session.error calls streamingUpdater.discard', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      const mockStreaming = createMockStreamingUpdater();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
        streamingUpdater: mockStreaming as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.error',
        text: 'Something went wrong',
      });

      expect(mockStreaming.discard).toHaveBeenCalledWith('test', 'claude');
    });

    it('auto-pending creates pending and posts tool activity as thread reply', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.hasPending.mockReturnValue(false);
      mockPendingTracker.ensurePending = vi.fn().mockImplementation(async () => {
        // After ensurePending, getPending returns a new entry (without startMessageId)
        mockPendingTracker.getPending.mockReturnValue({
          channelId: 'ch-123',
          messageId: '',
        });
      });
      // ensureStartMessage lazily creates the start message
      mockPendingTracker.ensureStartMessage.mockResolvedValue('auto-start-msg');
      const mockStreaming = createMockStreamingUpdater();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
        streamingUpdater: mockStreaming as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });

      expect(mockPendingTracker.ensurePending).toHaveBeenCalled();
      expect(mockPendingTracker.ensureStartMessage).toHaveBeenCalled();
      expect(mockStreaming.start).toHaveBeenCalledWith('test', 'claude', 'ch-123', 'auto-start-msg');
      // Tool activity goes to thread reply AND streaming updater (parent message preview)
      expect(mockStreaming.append).toHaveBeenCalledWith('test', 'claude', '📖 Read(`src/index.ts`)');
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledWith('ch-123', 'auto-start-msg', '📖 Read(`src/index.ts`)');
    });

    it('full lifecycle: tool activities replaced in thread → finalize', async () => {
      const mockMessaging = createMockMessaging();
      const mockPendingTracker = createMockPendingTracker();
      mockPendingTracker.hasPending.mockReturnValue(false);
      mockPendingTracker.ensurePending = vi.fn().mockImplementation(async () => {
        mockPendingTracker.hasPending.mockReturnValue(true);
        // ensurePending creates the entry WITHOUT startMessageId
        mockPendingTracker.getPending.mockReturnValue({
          channelId: 'ch-123',
          messageId: '',
        });
      });
      // ensureStartMessage lazily creates the start message and updates the pending entry
      mockPendingTracker.ensureStartMessage.mockImplementation(async () => {
        mockPendingTracker.getPending.mockReturnValue({
          channelId: 'ch-123',
          messageId: '',
          startMessageId: 'auto-start-msg',
        });
        return 'auto-start-msg';
      });
      const mockStreaming = createMockStreamingUpdater();
      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          agents: { claude: true },
          discordChannels: { claude: 'ch-123' },
          instances: {
            claude: { instanceId: 'claude', agentType: 'claude', channelId: 'ch-123' },
          },
          createdAt: new Date(),
          lastActive: new Date(),
        },
      });
      startServer({
        messaging: mockMessaging as any,
        stateManager: stateManager as any,
        pendingTracker: mockPendingTracker as any,
        streamingUpdater: mockStreaming as any,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Step 1: tool.activity triggers auto-pending + thread reply
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '📖 Read(`src/index.ts`)',
      });

      // Step 2: another tool.activity as thread reply
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text: '✏️ Edit(`src/config.ts`)',
      });

      // Step 3: session.idle finalizes
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'session.idle',
        text: 'Done!',
      });

      expect(mockStreaming.start).toHaveBeenCalledWith('test', 'claude', 'ch-123', 'auto-start-msg');
      // Tool activities go to thread AND streaming updater (parent message preview)
      expect(mockStreaming.append).toHaveBeenCalledTimes(2);
      expect(mockStreaming.append).toHaveBeenCalledWith('test', 'claude', '📖 Read(`src/index.ts`)');
      expect(mockStreaming.append).toHaveBeenCalledWith('test', 'claude', '✏️ Edit(`src/config.ts`)');
      expect(mockStreaming.finalize).toHaveBeenCalledWith('test', 'claude', undefined, 'auto-start-msg');
      // First tool activity creates thread reply, second appends to it
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledTimes(1);
      expect(mockMessaging.replyInThreadWithId).toHaveBeenCalledWith('ch-123', 'auto-start-msg', '📖 Read(`src/index.ts`)');
      expect(mockMessaging.updateMessage).toHaveBeenCalledWith('ch-123', 'thread-msg-ts', '📖 Read(`src/index.ts`)\n✏️ Edit(`src/config.ts`)');
      // Response text goes to channel
      expect(mockMessaging.sendToChannel).toHaveBeenCalledWith('ch-123', 'Done!');
    });
  });

  describe('HTTP method filtering', () => {
    it('rejects non-POST requests', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port, path: '/reload', method: 'GET' },
          (res) => resolve({ status: res.statusCode || 0 }),
        );
        req.on('error', reject);
        req.end();
      });
      expect(res.status).toBe(405);
    });
  });

  describe('request limits', () => {
    it('returns 413 when body is too large', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const huge = JSON.stringify({ text: 'x'.repeat(300_000) });
      const res = await postRaw(port, '/runtime/input', huge);
      expect(res.status).toBe(413);
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/unknown', {});
      expect(res.status).toBe(404);
    });
  });

  describe('runtime control API', () => {
    function createMockRuntime() {
      const windows = [
        {
          sessionName: 'bridge',
          windowName: 'project-claude',
          status: 'running',
          pid: 1234,
        },
      ];

      return {
        getOrCreateSession: vi.fn().mockReturnValue('bridge'),
        setSessionEnv: vi.fn(),
        windowExists: vi.fn((sessionName: string, windowName: string) => sessionName === 'bridge' && windowName === 'project-claude'),
        startAgentInWindow: vi.fn(),
        sendKeysToWindow: vi.fn(),
        typeKeysToWindow: vi.fn(),
        sendEnterToWindow: vi.fn(),
        stopWindow: vi.fn().mockReturnValue(true),
        listWindows: vi.fn().mockReturnValue(windows),
        getWindowBuffer: vi.fn().mockReturnValue('hello-runtime'),
      };
    }

    it('returns runtime windows via GET /runtime/windows', async () => {
      startServer({ runtime: createMockRuntime() as any });
      await new Promise((r) => setTimeout(r, 50));

      const res = await getRequest(port, '/runtime/windows');
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body) as { windows: Array<{ windowId: string }> };
      expect(parsed.windows[0].windowId).toBe('bridge:project-claude');
    });

    it('focuses and sends input to runtime window', async () => {
      const runtime = createMockRuntime();
      startServer({ runtime: runtime as any });
      await new Promise((r) => setTimeout(r, 50));

      const focusRes = await postJSON(port, '/runtime/focus', { windowId: 'bridge:project-claude' });
      expect(focusRes.status).toBe(200);

      const inputRes = await postJSON(port, '/runtime/input', {
        text: 'hello',
        submit: true,
      });
      expect(inputRes.status).toBe(200);
      expect(runtime.typeKeysToWindow).toHaveBeenCalledWith('bridge', 'project-claude', 'hello');
      expect(runtime.sendEnterToWindow).toHaveBeenCalledWith('bridge', 'project-claude');
    });

    it('returns buffer slices via GET /runtime/buffer', async () => {
      startServer({ runtime: createMockRuntime() as any });
      await new Promise((r) => setTimeout(r, 50));

      const res = await getRequest(port, '/runtime/buffer?windowId=bridge:project-claude&since=5');
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body) as { chunk: string; next: number };
      expect(parsed.chunk).toBe('-runtime');
      expect(parsed.next).toBe(13);
    });

    it('returns 501 when runtime control is unavailable', async () => {
      startServer();
      await new Promise((r) => setTimeout(r, 50));

      const res = await getRequest(port, '/runtime/windows');
      expect(res.status).toBe(501);
    });

    it('stops runtime window via POST /runtime/stop', async () => {
      const runtime = createMockRuntime();
      startServer({ runtime: runtime as any });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/runtime/stop', { windowId: 'bridge:project-claude' });
      expect(res.status).toBe(200);
      expect(runtime.stopWindow).toHaveBeenCalledWith('bridge', 'project-claude');
    });

    it('ensures runtime window via POST /runtime/ensure', async () => {
      const runtime = createMockRuntime();
      runtime.windowExists = vi.fn().mockReturnValue(false);

      const stateManager = createMockStateManager({
        test: {
          projectName: 'test',
          projectPath: tempDir,
          tmuxSession: 'bridge',
          createdAt: new Date().toISOString(),
          lastActive: new Date().toISOString(),
          instances: {
            opencode: {
              instanceId: 'opencode',
              agentType: 'opencode',
              tmuxWindow: 'test-opencode',
              channelId: 'C123',
            },
          },
        },
      });

      startServer({ runtime: runtime as any, stateManager: stateManager as any });
      await new Promise((r) => setTimeout(r, 50));

      const res = await postJSON(port, '/runtime/ensure', { projectName: 'test', instanceId: 'opencode' });
      expect(res.status).toBe(200);
      expect(runtime.startAgentInWindow).toHaveBeenCalledWith(
        'bridge',
        'test-opencode',
        expect.stringContaining('opencode'),
      );
    });
  });
});
