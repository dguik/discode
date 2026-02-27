import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { BridgeHookServer } from '../../src/bridge/hook-server.js';
import type { BridgeHookServerDeps } from '../../src/bridge/hook-server.js';
import {
  createMockMessaging, createMockPendingTracker,
  createMockStateManager, postJSON, createServerDeps,
} from './hook-server-helpers.js';

describe('BridgeHookServer — idle response promptQuestions → sendQuestionWithButtons', () => {
  let tempDir: string;
  let server: BridgeHookServer;
  let port: number;

  beforeEach(() => {
    const rawDir = join(tmpdir(), `discode-hookserver-test-${Date.now()}`);
    mkdirSync(rawDir, { recursive: true });
    tempDir = realpathSync(rawDir);
  });

  afterEach(() => {
    server?.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function startServer(deps: Partial<BridgeHookServerDeps> = {}): Promise<BridgeHookServer> {
    server = new BridgeHookServer(createServerDeps(0, deps));
    server.start();
    await server.ready();
    port = server.address()!.port;
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

  it('calls sendQuestionWithButtons when promptQuestions is provided', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Choose an approach.',
      promptQuestions: [
        {
          question: 'Which library should we use?',
          header: 'Auth method',
          options: [
            { label: 'OAuth', description: 'Standard OAuth 2.0 flow' },
            { label: 'JWT', description: 'Token-based authentication' },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);

    // sendQuestionWithButtons should be called with the structured questions
    expect(mockMessaging.sendQuestionWithButtons).toHaveBeenCalledTimes(1);
    const [channelId, questions] = mockMessaging.sendQuestionWithButtons.mock.calls[0];
    expect(channelId).toBe('ch-123');
    expect(questions).toHaveLength(1);
    expect(questions[0].question).toBe('Which library should we use?');
    expect(questions[0].header).toBe('Auth method');
    expect(questions[0].options).toHaveLength(2);
    expect(questions[0].options[0].label).toBe('OAuth');
  });

  it('does not send promptText as plain text when promptQuestions is used', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Pick one.',
      promptText: '❓ *Auth*\nWhich?\n• *OAuth*\n• *JWT*',
      promptQuestions: [
        {
          question: 'Which?',
          header: 'Auth',
          options: [{ label: 'OAuth' }, { label: 'JWT' }],
        },
      ],
    });
    expect(res.status).toBe(200);

    // Buttons should be used, not plain text prompt
    expect(mockMessaging.sendQuestionWithButtons).toHaveBeenCalledTimes(1);

    // sendToChannel calls should only contain the response text, not the promptText
    const textCalls = mockMessaging.sendToChannel.mock.calls.map((c: any[]) => c[1]);
    for (const text of textCalls) {
      expect(text).not.toContain('❓ *Auth*');
    }
  });

  it('falls back to promptText when promptQuestions is empty array', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Here are the options.',
      promptText: '📋 Plan approval needed',
      promptQuestions: [],
    });
    expect(res.status).toBe(200);

    // No buttons — empty array
    expect(mockMessaging.sendQuestionWithButtons).not.toHaveBeenCalled();
    // Falls back to promptText
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-123',
      expect.stringContaining('Plan approval needed'),
    );
  });

  it('falls back to promptText when promptQuestions has invalid items', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Choose.',
      promptText: '❓ Pick one',
      promptQuestions: [
        { question: 'Missing options?' },
        { options: [{ label: 'A' }] },
        'not an object',
      ],
    });
    expect(res.status).toBe(200);

    // All items are invalid — no valid question+options combo
    expect(mockMessaging.sendQuestionWithButtons).not.toHaveBeenCalled();
    // Falls back to promptText
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-123',
      expect.stringContaining('Pick one'),
    );
  });

  it('falls back to promptText when promptQuestions is not an array', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Options below.',
      promptText: '❓ Choose approach',
      promptQuestions: 'not an array',
    });
    expect(res.status).toBe(200);

    expect(mockMessaging.sendQuestionWithButtons).not.toHaveBeenCalled();
    expect(mockMessaging.sendToChannel).toHaveBeenCalledWith(
      'ch-123',
      expect.stringContaining('Choose approach'),
    );
  });

  it('sends buttons without text when only promptQuestions is provided', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: '',
      promptQuestions: [
        {
          question: 'Which database?',
          options: [
            { label: 'PostgreSQL', description: 'Relational' },
            { label: 'MongoDB', description: 'Document' },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);

    expect(mockMessaging.sendQuestionWithButtons).toHaveBeenCalledTimes(1);
    // No text to send — sendToChannel should not be called for response text
    expect(mockMessaging.sendToChannel).not.toHaveBeenCalled();
  });

  it('handles multiple questions in promptQuestions', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'A few decisions needed.',
      promptQuestions: [
        {
          question: 'Which framework?',
          header: 'Framework',
          options: [{ label: 'React' }, { label: 'Vue' }],
        },
        {
          question: 'Which CSS?',
          header: 'Styling',
          options: [{ label: 'Tailwind' }, { label: 'CSS Modules' }],
        },
      ],
    });
    expect(res.status).toBe(200);

    expect(mockMessaging.sendQuestionWithButtons).toHaveBeenCalledTimes(1);
    const questions = mockMessaging.sendQuestionWithButtons.mock.calls[0][1];
    expect(questions).toHaveLength(2);
    expect(questions[0].question).toBe('Which framework?');
    expect(questions[1].question).toBe('Which CSS?');
  });

  it('preserves multiSelect flag in promptQuestions', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Select features.',
      promptQuestions: [
        {
          question: 'Which features to enable?',
          header: 'Features',
          options: [
            { label: 'Auth', description: 'Authentication' },
            { label: 'Logging', description: 'Request logging' },
          ],
          multiSelect: true,
        },
      ],
    });
    expect(res.status).toBe(200);

    expect(mockMessaging.sendQuestionWithButtons).toHaveBeenCalledTimes(1);
    const questions = mockMessaging.sendQuestionWithButtons.mock.calls[0][1];
    expect(questions[0].multiSelect).toBe(true);
  });

  it('filters out invalid items and uses remaining valid ones', async () => {
    const mockMessaging = createMockMessaging();
    await startServer({
      messaging: mockMessaging as any,
      stateManager: makeState() as any,
      pendingTracker: createMockPendingTracker() as any,
    });

    const res = await postJSON(port, '/opencode-event', {
      projectName: 'test',
      agentType: 'claude',
      type: 'session.idle',
      text: 'Pick one.',
      promptQuestions: [
        { question: 'Missing options field' },
        {
          question: 'Valid question?',
          options: [{ label: 'Yes' }, { label: 'No' }],
        },
        null,
      ],
    });
    expect(res.status).toBe(200);

    expect(mockMessaging.sendQuestionWithButtons).toHaveBeenCalledTimes(1);
    const questions = mockMessaging.sendQuestionWithButtons.mock.calls[0][1];
    expect(questions).toHaveLength(1);
    expect(questions[0].question).toBe('Valid question?');
  });
});
