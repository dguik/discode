/**
 * Functional tests for the Codex notify hook script.
 *
 * Tests the actual behavior of discode-codex-notify.js by executing it
 * in a child process with controlled argv and environment variables,
 * then verifying the HTTP POST it makes to the bridge endpoint.
 */

import { existsSync, readFileSync } from 'fs';
import http from 'http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getCodexHookSourcePath } from '../../src/codex/hook-installer.js';

interface CapturedRequest {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

function startCaptureServer(): Promise<{ server: http.Server; port: number; requests: CapturedRequest[] }> {
  return new Promise((resolve) => {
    const requests: CapturedRequest[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        requests.push({
          method: req.method || '',
          url: req.url || '',
          body: JSON.parse(body || '{}'),
        });
        res.writeHead(200);
        res.end('ok');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port, requests });
    });
  });
}

function runHookScript(
  scriptPath: string,
  argv2: string,
  env: Record<string, string>,
): Promise<{ exitCode: number | null }> {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile(
      process.execPath,
      [scriptPath, argv2],
      { env: { ...env, PATH: process.env.PATH }, timeout: 5000 },
      (error: any, _stdout: string, _stderr: string) => {
        resolve({ exitCode: error ? error.code ?? 1 : 0 });
      },
    );
  });
}

describe('codex notify hook script', () => {
  let server: http.Server;
  let port: number;
  let requests: CapturedRequest[];
  const scriptPath = getCodexHookSourcePath();

  beforeAll(async () => {
    const capture = await startCaptureServer();
    server = capture.server;
    port = capture.port;
    requests = capture.requests;
  });

  afterAll(() => {
    server.close();
  });

  afterEach(() => {
    requests.length = 0;
  });

  it('source hook file exists and is readable', () => {
    expect(existsSync(scriptPath)).toBe(true);
    const content = readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('agent-turn-complete');
    expect(content).toContain('process.argv[2]');
  });

  it('posts session.idle to bridge on agent-turn-complete event', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'Here is the fix for the bug.',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
      DISCODE_AGENT: 'codex',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].url).toBe('/opencode-event');
    expect(requests[0].body).toEqual({
      projectName: 'test-project',
      agentType: 'codex',
      type: 'session.idle',
      text: 'Here is the fix for the bug.',
    });
  });

  it('includes instanceId in payload when DISCODE_INSTANCE is set', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'done',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
      DISCODE_INSTANCE: 'codex-2',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.instanceId).toBe('codex-2');
  });

  it('omits instanceId when DISCODE_INSTANCE is not set', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'done',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body).not.toHaveProperty('instanceId');
  });

  it('does not post when event type is not agent-turn-complete', async () => {
    const payload = JSON.stringify({
      type: 'some-other-event',
      'last-assistant-message': 'should not appear',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(0);
  });

  it('does not post when DISCODE_PROJECT is empty', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'should not appear',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: '',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(0);
  });

  it('does not post when DISCODE_PROJECT is not set', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'should not appear',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(0);
  });

  it('handles empty argv gracefully (no JSON argument)', async () => {
    await runHookScript(scriptPath, '', {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    // Empty JSON parses as {}, type won't match, no post
    expect(requests).toHaveLength(0);
  });

  it('handles malformed JSON in argv gracefully', async () => {
    await runHookScript(scriptPath, 'not-valid-json{{{', {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    // Malformed JSON catches and sets input = {}, no match, no post
    expect(requests).toHaveLength(0);
  });

  it('trims whitespace from last-assistant-message', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': '  hello world  \n',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.text).toBe('hello world');
  });

  it('sends empty text when last-assistant-message is missing', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.text).toBe('');
  });

  it('sends empty text when last-assistant-message is not a string', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 12345,
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.text).toBe('');
  });

  it('uses default agent type "codex" when DISCODE_AGENT is not set', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'test',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
      // DISCODE_AGENT not set
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.agentType).toBe('codex');
  });

  // ---------- Legacy env var fallback (AGENT_DISCORD_*) ----------

  it('falls back to AGENT_DISCORD_PROJECT when DISCODE_PROJECT is not set', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'legacy env',
    });

    await runHookScript(scriptPath, payload, {
      AGENT_DISCORD_PROJECT: 'legacy-proj',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.projectName).toBe('legacy-proj');
  });

  it('falls back to AGENT_DISCORD_AGENT when DISCODE_AGENT is not set', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'test',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      AGENT_DISCORD_AGENT: 'legacy-agent',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.agentType).toBe('legacy-agent');
  });

  it('falls back to AGENT_DISCORD_PORT and AGENT_DISCORD_HOSTNAME', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'port test',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      AGENT_DISCORD_PORT: String(port),
      AGENT_DISCORD_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.text).toBe('port test');
  });

  it('DISCODE_* takes precedence over AGENT_DISCORD_*', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'priority',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'new-proj',
      AGENT_DISCORD_PROJECT: 'old-proj',
      DISCODE_AGENT: 'new-agent',
      AGENT_DISCORD_AGENT: 'old-agent',
      DISCODE_PORT: String(port),
      AGENT_DISCORD_PORT: '99999',
      DISCODE_HOSTNAME: '127.0.0.1',
      AGENT_DISCORD_HOSTNAME: '10.0.0.1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.projectName).toBe('new-proj');
    expect(requests[0].body.agentType).toBe('new-agent');
  });

  it('falls back to AGENT_DISCORD_INSTANCE for instanceId', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'inst',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      AGENT_DISCORD_INSTANCE: 'legacy-inst',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.instanceId).toBe('legacy-inst');
  });

  it('works with only AGENT_DISCORD_* env vars (no DISCODE_* set)', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'full legacy',
    });

    await runHookScript(scriptPath, payload, {
      AGENT_DISCORD_PROJECT: 'legacy-proj',
      AGENT_DISCORD_AGENT: 'legacy-agent',
      AGENT_DISCORD_INSTANCE: 'legacy-inst',
      AGENT_DISCORD_PORT: String(port),
      AGENT_DISCORD_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body).toEqual({
      projectName: 'legacy-proj',
      agentType: 'legacy-agent',
      instanceId: 'legacy-inst',
      type: 'session.idle',
      text: 'full legacy',
    });
  });

  // ---------- Error resilience ----------

  it('silently handles bridge connection failure (no crash)', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'test',
    });

    // Use a port that's not listening
    const result = await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: '1', // unlikely to have a server
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    // Should not crash — exits gracefully
    expect(result.exitCode).toBe(0);
    expect(requests).toHaveLength(0);
  });

  // ---------- Tool activity extraction from input-messages ----------

  /** Helper to create an OpenAI-format input-messages array for a single tool call turn. */
  function makeToolTurnPayload(opts: {
    toolName: string;
    toolArgs: Record<string, unknown> | string;
    toolResult?: string;
    finalMessage?: string;
    userMessage?: string;
  }): string {
    const argsStr = typeof opts.toolArgs === 'string'
      ? opts.toolArgs
      : JSON.stringify(opts.toolArgs);
    return JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': opts.finalMessage ?? 'Done.',
      'input-messages': [
        { role: 'user', content: opts.userMessage ?? 'Do the task' },
        {
          role: 'assistant',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: opts.toolName, arguments: argsStr },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: opts.toolResult ?? '' },
        { role: 'assistant', content: opts.finalMessage ?? 'Done.' },
      ],
    });
  }

  const defaultEnv = () => ({
    DISCODE_PROJECT: 'test-project',
    DISCODE_PORT: String(port),
    DISCODE_HOSTNAME: '127.0.0.1',
    DISCODE_AGENT: 'codex',
  });

  it('sends tool.activity for shell command before session.idle', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'shell',
      toolArgs: { command: ['npm', 'test'] },
      toolResult: 'All tests passed',
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    // First: tool.activity
    expect(requests[0].body.type).toBe('tool.activity');
    expect(requests[0].body.text).toBe('\uD83D\uDCBB `npm test`');
    // Second: session.idle
    expect(requests[1].body.type).toBe('session.idle');
    expect(requests[1].body.text).toBe('Done.');
  });

  it('formats shell command string (not array)', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'shell',
      toolArgs: { command: 'ls -la /tmp' },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCBB `ls -la /tmp`');
  });

  it('truncates long shell commands at 100 chars', async () => {
    const longCmd = 'a'.repeat(120);
    const payload = makeToolTurnPayload({
      toolName: 'shell',
      toolArgs: { command: longCmd },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    const text = requests[0].body.text as string;
    expect(text).toContain('a'.repeat(100));
    expect(text).toContain('...');
  });

  it('detects git commit from shell output', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'shell',
      toolArgs: { command: ['git', 'commit', '-m', 'fix auth bug'] },
      toolResult: '[main abc1234] fix auth bug\n 1 file changed, 2 insertions(+)',
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    const text = requests[0].body.text as string;
    expect(text).toMatch(/^GIT_COMMIT:/);
    const data = JSON.parse(text.slice('GIT_COMMIT:'.length));
    expect(data.hash).toBe('abc1234');
    expect(data.message).toBe('fix auth bug');
    expect(data.stat).toBe('1 file changed, 2 insertions(+)');
  });

  it('detects git push from shell output', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'shell',
      toolArgs: { command: ['git', 'push', 'origin', 'main'] },
      toolResult: 'abc1234..def5678 main -> main',
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    const text = requests[0].body.text as string;
    expect(text).toMatch(/^GIT_PUSH:/);
    const data = JSON.parse(text.slice('GIT_PUSH:'.length));
    expect(data.toHash).toBe('def5678');
    expect(data.remoteRef).toBe('main');
  });

  it('formats apply_patch with file path and line delta', async () => {
    const patch = [
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -10,3 +10,5 @@',
      ' existing line',
      '+new line 1',
      '+new line 2',
    ].join('\n');

    const payload = makeToolTurnPayload({
      toolName: 'apply_patch',
      toolArgs: { patch },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\u270F\uFE0F Edit(`src/auth.ts`) +2 lines');
  });

  it('formats apply_patch with negative delta', async () => {
    const patch = [
      '--- a/src/old.ts',
      '+++ b/src/old.ts',
      '@@ -1,5 +1,3 @@',
      ' keep',
      '-removed 1',
      '-removed 2',
      '-removed 3',
      '+added 1',
    ].join('\n');

    const payload = makeToolTurnPayload({
      toolName: 'apply_patch',
      toolArgs: { patch },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\u270F\uFE0F Edit(`src/old.ts`) -2 lines');
  });

  it('formats apply_patch with equal additions and deletions', async () => {
    const patch = [
      '--- a/src/file.ts',
      '+++ b/src/file.ts',
      '@@ -1,2 +1,2 @@',
      '-old line',
      '+new line',
    ].join('\n');

    const payload = makeToolTurnPayload({
      toolName: 'apply_patch',
      toolArgs: { patch },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\u270F\uFE0F Edit(`src/file.ts`) \u00B11 lines');
  });

  it('formats apply_patch without valid path as Edit(unknown)', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'apply_patch',
      toolArgs: { patch: 'not a valid patch' },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\u270F\uFE0F Edit(unknown)');
  });

  it('formats read_file as Read(path)', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'read_file',
      toolArgs: { file_path: '/home/user/project/src/index.ts' },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCD6 Read(`user/project/src/index.ts`)');
  });

  it('formats container.read_file the same as read_file', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'container.read_file',
      toolArgs: { path: '/app/src/main.ts' },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCD6 Read(`app/src/main.ts`)');
  });

  it('formats create_file as Write(path) with line count', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'create_file',
      toolArgs: { file_path: '/project/src/new.ts', content: 'line1\nline2\nline3' },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCDD Write(`project/src/new.ts`) 3 lines');
  });

  it('formats container.create_file the same as create_file', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'container.create_file',
      toolArgs: { path: '/app/config.json', contents: '{\n  "key": "value"\n}' },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCDD Write(`app/config.json`) 3 lines');
  });

  it('formats list_dir as List(path)', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'list_dir',
      toolArgs: { path: '/home/user/project/src' },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCC2 List(`user/project/src`)');
  });

  it('formats container.list_dir the same as list_dir', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'container.list_dir',
      toolArgs: { path: '/app/src' },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCC2 List(`app/src`)');
  });

  it('formats unknown tools with gear emoji', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'custom_search',
      toolArgs: { query: 'something' },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\u2699\uFE0F custom_search');
  });

  it('sends multiple tool.activity events in order', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'All done.',
      'input-messages': [
        { role: 'user', content: 'Read and fix the file' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/src/app.ts"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'file contents here' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call_2', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ patch: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,2 @@\n old\n+new' }) } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_2', content: 'patch applied' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call_3', type: 'function', function: { name: 'shell', arguments: '{"command":"npm test"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_3', content: 'tests passed' },
        { role: 'assistant', content: 'All done.' },
      ],
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    // 3 tool.activity + 1 session.idle = 4
    expect(requests).toHaveLength(4);
    expect(requests[0].body.type).toBe('tool.activity');
    expect(requests[0].body.text).toBe('\uD83D\uDCD6 Read(`src/app.ts`)');
    expect(requests[1].body.type).toBe('tool.activity');
    expect((requests[1].body.text as string)).toContain('Edit(`src/app.ts`)');
    expect(requests[2].body.type).toBe('tool.activity');
    expect(requests[2].body.text).toBe('\uD83D\uDCBB `npm test`');
    expect(requests[3].body.type).toBe('session.idle');
    expect(requests[3].body.text).toBe('All done.');
  });

  it('sends only session.idle when no input-messages present', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'Just text.',
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(1);
    expect(requests[0].body.type).toBe('session.idle');
  });

  it('extracts only current turn tools (after last user message)', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'Second fix.',
      'input-messages': [
        // Previous turn
        { role: 'user', content: 'First task' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'old_1', type: 'function', function: { name: 'shell', arguments: '{"command":"echo old"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'old_1', content: 'old' },
        { role: 'assistant', content: 'Done first.' },
        // Current turn
        { role: 'user', content: 'Second task' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'new_1', type: 'function', function: { name: 'shell', arguments: '{"command":"echo new"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'new_1', content: 'new' },
        { role: 'assistant', content: 'Second fix.' },
      ],
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    // Only 1 tool.activity (from current turn) + 1 session.idle
    expect(requests).toHaveLength(2);
    expect(requests[0].body.type).toBe('tool.activity');
    expect(requests[0].body.text).toBe('\uD83D\uDCBB `echo new`');
    expect(requests[1].body.type).toBe('session.idle');
  });

  it('includes instanceId in tool.activity events', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'shell',
      toolArgs: { command: 'echo hi' },
    });

    await runHookScript(scriptPath, payload, {
      ...defaultEnv(),
      DISCODE_INSTANCE: 'codex-3',
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].body.instanceId).toBe('codex-3');
    expect(requests[0].body.type).toBe('tool.activity');
    expect(requests[1].body.instanceId).toBe('codex-3');
    expect(requests[1].body.type).toBe('session.idle');
  });

  it('skips tool calls with empty formatted output', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'shell',
      toolArgs: { command: '' },  // empty command → empty format → skip
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    // Only session.idle, no tool.activity for empty command
    expect(requests).toHaveLength(1);
    expect(requests[0].body.type).toBe('session.idle');
  });

  it('handles input-messages with user content as array (multimodal)', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'Done.',
      'input-messages': [
        { role: 'user', content: [{ type: 'text', text: 'Fix the bug' }] },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":"npm test"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
        { role: 'assistant', content: 'Done.' },
      ],
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.type).toBe('tool.activity');
    expect(requests[0].body.text).toBe('\uD83D\uDCBB `npm test`');
  });

  it('handles apply_patch with diff key (alternative field name)', async () => {
    const patch = '--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,1 +1,2 @@\n old\n+new';
    const payload = makeToolTurnPayload({
      toolName: 'apply_patch',
      toolArgs: { diff: patch },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\u270F\uFE0F Edit(`src/x.ts`) +1 lines');
  });

  // ---------- Edge cases: multi-file patch ----------

  it('apply_patch with multiple files uses first file path', async () => {
    const patch = [
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -1,2 +1,3 @@',
      ' line1',
      '+added in auth',
      '--- a/src/utils.ts',
      '+++ b/src/utils.ts',
      '@@ -5,3 +5,5 @@',
      ' existing',
      '+new1',
      '+new2',
    ].join('\n');

    const payload = makeToolTurnPayload({
      toolName: 'apply_patch',
      toolArgs: { patch },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    // First file path used, total delta across all files: +3 additions, 0 deletions
    expect(requests[0].body.text).toBe('\u270F\uFE0F Edit(`src/auth.ts`) +3 lines');
  });

  it('apply_patch with empty patch string shows Edit(unknown)', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'apply_patch',
      toolArgs: { patch: '' },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\u270F\uFE0F Edit(unknown)');
  });

  it('apply_patch with no patch or diff key shows Edit(unknown)', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'apply_patch',
      toolArgs: { something_else: 'value' },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\u270F\uFE0F Edit(unknown)');
  });

  // ---------- Edge cases: shortenPath ----------

  it('shortenPath keeps short paths unchanged (2 segments, maxSegments=4)', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'read_file',
      toolArgs: { file_path: '/src/index.ts' },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    // 2 segments <= maxSegments(4), so path is kept as-is
    expect(requests[0].body.text).toBe('\uD83D\uDCD6 Read(`src/index.ts`)');
  });

  it('shortenPath truncates deeply nested paths to last 4 segments', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'read_file',
      toolArgs: { file_path: '/a/b/c/d/e/f/g.ts' },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    // 7 segments > 4, keep last 4: d/e/f/g.ts
    expect(requests[0].body.text).toBe('\uD83D\uDCD6 Read(`d/e/f/g.ts`)');
  });

  it('list_dir shortenPath uses maxSegments=3', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'list_dir',
      toolArgs: { path: '/a/b/c/d/e' },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    // 5 segments > 3, keep last 3: c/d/e
    expect(requests[0].body.text).toBe('\uD83D\uDCC2 List(`c/d/e`)');
  });

  // ---------- Edge cases: extractCurrentTurnTools ----------

  it('extracts all tools when no user message exists (first turn)', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'Done.',
      'input-messages': [
        // No user message — system-only start
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":"whoami"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'root' },
        { role: 'assistant', content: 'Done.' },
      ],
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    // Should extract the tool call since turnStartIndex defaults to 0
    expect(requests).toHaveLength(2);
    expect(requests[0].body.type).toBe('tool.activity');
    expect(requests[0].body.text).toBe('\uD83D\uDCBB `whoami`');
  });

  it('handles empty input-messages array', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'Done.',
      'input-messages': [],
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    // No tool calls, only session.idle
    expect(requests).toHaveLength(1);
    expect(requests[0].body.type).toBe('session.idle');
  });

  it('handles input-messages with only user messages (no tool calls)', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'Sure, here you go.',
      'input-messages': [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Sure, here you go.' },
      ],
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(1);
    expect(requests[0].body.type).toBe('session.idle');
    expect(requests[0].body.text).toBe('Sure, here you go.');
  });

  it('skips user messages without text content (tool result injection)', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'Done.',
      'input-messages': [
        // Real user message
        { role: 'user', content: 'First task' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'old_1', type: 'function', function: { name: 'shell', arguments: '{"command":"echo old"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'old_1', content: 'old' },
        // User message with empty content (e.g., system injected)
        { role: 'user', content: '' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'new_1', type: 'function', function: { name: 'shell', arguments: '{"command":"echo new"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'new_1', content: 'new' },
        { role: 'assistant', content: 'Done.' },
      ],
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    // Empty user message is skipped as turn boundary, so "First task" is the boundary
    // Both tool calls are after "First task", so both are included
    expect(requests).toHaveLength(3);
    expect(requests[0].body.text).toBe('\uD83D\uDCBB `echo old`');
    expect(requests[1].body.text).toBe('\uD83D\uDCBB `echo new`');
    expect(requests[2].body.type).toBe('session.idle');
  });

  // ---------- Edge cases: safeParse / malformed arguments ----------

  it('handles malformed JSON in tool arguments gracefully', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'Done.',
      'input-messages': [
        { role: 'user', content: 'Do something' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{invalid json' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'result' },
        { role: 'assistant', content: 'Done.' },
      ],
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    // safeParse returns {}, no command → empty format → skip tool.activity
    expect(requests).toHaveLength(1);
    expect(requests[0].body.type).toBe('session.idle');
  });

  it('handles tool_calls with missing function field', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'Done.',
      'input-messages': [
        { role: 'user', content: 'Do something' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call_1', type: 'function' },  // no function field
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '' },
        { role: 'assistant', content: 'Done.' },
      ],
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    // No crash, tool_call without function is skipped
    expect(requests).toHaveLength(1);
    expect(requests[0].body.type).toBe('session.idle');
  });

  it('handles tool response with non-string content', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'Done.',
      'input-messages': [
        { role: 'user', content: 'Check something' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 12345 },  // non-string content
        { role: 'assistant', content: 'Done.' },
      ],
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.type).toBe('tool.activity');
    expect(requests[0].body.text).toBe('\uD83D\uDCBB `ls`');
  });

  // ---------- Edge cases: git detection ----------

  it('shell with git commit but no matching output falls back to shell format', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'shell',
      toolArgs: { command: ['git', 'commit', '-m', 'test'] },
      toolResult: 'nothing to commit, working tree clean',
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    // No commit hash pattern → falls back to shell format
    expect(requests[0].body.text).toBe('\uD83D\uDCBB `git commit -m test`');
  });

  it('shell with git push but no matching output falls back to shell format', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'shell',
      toolArgs: { command: ['git', 'push', 'origin', 'main'] },
      toolResult: 'Everything up-to-date',
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCBB `git push origin main`');
  });

  it('git commit with stats including deletions', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'shell',
      toolArgs: { command: 'git commit -m "refactor"' },
      toolResult: '[main def5678] refactor\n 3 files changed, 10 insertions(+), 5 deletions(-)',
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    const text = requests[0].body.text as string;
    const data = JSON.parse(text.slice('GIT_COMMIT:'.length));
    expect(data.hash).toBe('def5678');
    expect(data.message).toBe('refactor');
    expect(data.stat).toBe('3 files changed, 10 insertions(+), 5 deletions');
  });

  it('git commit on a branch with slashes in name', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'shell',
      toolArgs: { command: 'git commit -m "fix"' },
      toolResult: '[feature/auth-v2 aaa1111] fix\n 1 file changed, 1 insertion(+)',
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    const text = requests[0].body.text as string;
    expect(text).toMatch(/^GIT_COMMIT:/);
    const data = JSON.parse(text.slice('GIT_COMMIT:'.length));
    expect(data.hash).toBe('aaa1111');
    expect(data.message).toBe('fix');
  });

  // ---------- Edge cases: read_file / create_file with missing path ----------

  it('read_file with no file_path or path is skipped', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'read_file',
      toolArgs: { something: 'irrelevant' },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    // Empty format → skip tool.activity
    expect(requests).toHaveLength(1);
    expect(requests[0].body.type).toBe('session.idle');
  });

  it('create_file with no file_path or path is skipped', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'create_file',
      toolArgs: { content: 'some content' },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(1);
    expect(requests[0].body.type).toBe('session.idle');
  });

  it('create_file with empty content shows 0 line count suffix omitted', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'create_file',
      toolArgs: { file_path: '/src/empty.ts', content: '' },
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    // Empty content → lineCount 0 → no suffix
    expect(requests[0].body.text).toBe('\uD83D\uDCDD Write(`src/empty.ts`)');
  });

  // ---------- Edge cases: list_dir defaults ----------

  it('list_dir with no path defaults to "."', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'list_dir',
      toolArgs: {},
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCC2 List(`.`)');
  });

  // ---------- Edge cases: tool with no name ----------

  it('tool call with empty name is skipped', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'Done.',
      'input-messages': [
        { role: 'user', content: 'Do it' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: '', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '' },
        { role: 'assistant', content: 'Done.' },
      ],
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    expect(requests).toHaveLength(1);
    expect(requests[0].body.type).toBe('session.idle');
  });

  // ---------- Edge cases: multiple tool_calls in single assistant message ----------

  it('handles multiple tool_calls in a single assistant message', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'Read both.',
      'input-messages': [
        { role: 'user', content: 'Read two files' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/src/a.ts"}' } },
            { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/src/b.ts"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'content a' },
        { role: 'tool', tool_call_id: 'call_2', content: 'content b' },
        { role: 'assistant', content: 'Read both.' },
      ],
    });

    await runHookScript(scriptPath, payload, defaultEnv());

    // 2 tool.activity + 1 session.idle
    expect(requests).toHaveLength(3);
    expect(requests[0].body.text).toBe('\uD83D\uDCD6 Read(`src/a.ts`)');
    expect(requests[1].body.text).toBe('\uD83D\uDCD6 Read(`src/b.ts`)');
    expect(requests[2].body.type).toBe('session.idle');
  });
});
