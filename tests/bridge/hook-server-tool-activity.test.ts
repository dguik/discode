import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BridgeHookServer } from '../../src/bridge/hook-server.js';
import type { BridgeHookServerDeps } from '../../src/bridge/hook-server.js';
import {
  createMockMessaging, createMockPendingTracker,
  createMockStateManager, postJSON, createServerDeps,
} from './hook-server-helpers.js';

describe('BridgeHookServer — tool.activity streaming only', () => {
  let tempDir: string;
  let server: BridgeHookServer;
  let port: number;

  beforeEach(() => {
    const rawDir = join(tmpdir(), `discode-hookserver-test-${Date.now()}`);
    mkdirSync(rawDir, { recursive: true });
    tempDir = realpathSync(rawDir);
    port = 19000 + Math.floor(Math.random() * 1000);
  });

  afterEach(() => {
    server?.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function startServer(deps: Partial<BridgeHookServerDeps> = {}): BridgeHookServer {
    server = new BridgeHookServer(createServerDeps(port, deps));
    server.start();
    return server;
  }

  function makeState() {
    return createMockStateManager({
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
  }

  it('tool.activity does not send channel or thread messages', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts');
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-user-1',
      startMessageId: 'start-msg-ts',
    });
    startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
    });
    await new Promise((r) => setTimeout(r, 50));

    const res1 = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.activity',
      text: '📖 Read(`src/index.ts`)',
    });
    expect(res1.status).toBe(200);

    const res2 = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'tool.activity',
      text: '✏️ Edit(`src/config.ts`)',
    });
    expect(res2.status).toBe(200);

    // tool.activity should not send channel or thread messages
    expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    expect(mockMessaging.replyInThread).not.toHaveBeenCalled();
    expect(mockMessaging.replyInThreadWithId).not.toHaveBeenCalled();
    expect(mockMessaging.updateMessage).not.toHaveBeenCalled();
  });

  it('tool.activity with multiple events only uses streaming updater', async () => {
    const mockMessaging = createMockMessaging();
    const mockPendingTracker = createMockPendingTracker();
    mockPendingTracker.ensureStartMessage.mockResolvedValue('start-msg-ts');
    mockPendingTracker.getPending.mockReturnValue({
      channelId: 'ch-123',
      messageId: 'msg-user-1',
      startMessageId: 'start-msg-ts',
    });
    startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: mockPendingTracker as any,
    });
    await new Promise((r) => setTimeout(r, 50));

    const activities = [
      '📖 Read(`src/one.ts`)',
      '📖 Read(`src/two.ts`)',
      '✏️ Edit(`src/three.ts`)',
    ];
    for (const text of activities) {
      await postJSON(port, '/opencode-event', {
        projectName: 'test',
        agentType: 'claude',
        type: 'tool.activity',
        text,
      });
    }

    // No thread replies or channel messages
    expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
    expect(mockMessaging.replyInThreadWithId).not.toHaveBeenCalled();
    expect(mockMessaging.updateMessage).not.toHaveBeenCalled();
  });
});
