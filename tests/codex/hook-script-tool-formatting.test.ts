/**
 * Tool activity formatting tests for the Codex notify hook script.
 *
 * Tests shell commands, git detection, apply_patch, read_file,
 * create_file, list_dir, container-prefixed tools, and unknown tools.
 */

import http from 'http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getCodexHookSourcePath } from '../../src/codex/hook-installer.js';
import {
  type CapturedRequest,
  startCaptureServer,
  runHookScript,
  makeToolTurnPayload,
  defaultEnv,
} from './hook-script-helpers.js';

describe('codex hook – tool activity formatting', () => {
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

  const env = () => defaultEnv(port);

  it('sends tool.activity for shell command before session.idle', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'shell',
      toolArgs: { command: ['npm', 'test'] },
      toolResult: 'All tests passed',
    });

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.type).toBe('tool.activity');
    expect(requests[0].body.text).toBe('\uD83D\uDCBB `npm test`');
    expect(requests[1].body.type).toBe('session.idle');
    expect(requests[1].body.text).toBe('Done.');
  });

  it('formats shell command string (not array)', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'shell',
      toolArgs: { command: 'ls -la /tmp' },
    });

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCBB `ls -la /tmp`');
  });

  it('truncates long shell commands at 100 chars', async () => {
    const longCmd = 'a'.repeat(120);
    const payload = makeToolTurnPayload({
      toolName: 'shell',
      toolArgs: { command: longCmd },
    });

    await runHookScript(scriptPath, payload, env());

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

    await runHookScript(scriptPath, payload, env());

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

    await runHookScript(scriptPath, payload, env());

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

    await runHookScript(scriptPath, payload, env());

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

    await runHookScript(scriptPath, payload, env());

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

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\u270F\uFE0F Edit(`src/file.ts`) \u00B11 lines');
  });

  it('formats apply_patch without valid path as Edit(unknown)', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'apply_patch',
      toolArgs: { patch: 'not a valid patch' },
    });

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\u270F\uFE0F Edit(unknown)');
  });

  it('formats read_file as Read(path)', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'read_file',
      toolArgs: { file_path: '/home/user/project/src/index.ts' },
    });

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCD6 Read(`user/project/src/index.ts`)');
  });

  it('formats container.read_file the same as read_file', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'container.read_file',
      toolArgs: { path: '/app/src/main.ts' },
    });

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCD6 Read(`app/src/main.ts`)');
  });

  it('formats create_file as Write(path) with line count', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'create_file',
      toolArgs: { file_path: '/project/src/new.ts', content: 'line1\nline2\nline3' },
    });

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCDD Write(`project/src/new.ts`) 3 lines');
  });

  it('formats container.create_file the same as create_file', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'container.create_file',
      toolArgs: { path: '/app/config.json', contents: '{\n  "key": "value"\n}' },
    });

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCDD Write(`app/config.json`) 3 lines');
  });

  it('formats list_dir as List(path)', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'list_dir',
      toolArgs: { path: '/home/user/project/src' },
    });

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCC2 List(`user/project/src`)');
  });

  it('formats container.list_dir the same as list_dir', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'container.list_dir',
      toolArgs: { path: '/app/src' },
    });

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCC2 List(`app/src`)');
  });

  it('formats unknown tools with gear emoji', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'custom_search',
      toolArgs: { query: 'something' },
    });

    await runHookScript(scriptPath, payload, env());

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

    await runHookScript(scriptPath, payload, env());

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

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(1);
    expect(requests[0].body.type).toBe('session.idle');
  });

  it('includes instanceId in tool.activity events', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'shell',
      toolArgs: { command: 'echo hi' },
    });

    await runHookScript(scriptPath, payload, {
      ...env(),
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
      toolArgs: { command: '' },  // empty command -> empty format -> skip
    });

    await runHookScript(scriptPath, payload, env());

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

    await runHookScript(scriptPath, payload, env());

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

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\u270F\uFE0F Edit(`src/x.ts`) +1 lines');
  });
});
