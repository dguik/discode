/**
 * Edge case tests for the Codex notify hook script.
 *
 * Tests multi-file patches, path shortening, current turn extraction,
 * user message handling, malformed arguments, git detection patterns,
 * file path handling, tool name validation, and multiple tool calls.
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

describe('codex hook – edge cases', () => {
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

  // ---------- Multi-file patch ----------

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

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    // First file path used, total delta across all files: +3 additions, 0 deletions
    expect(requests[0].body.text).toBe('\u270F\uFE0F Edit(`src/auth.ts`) +3 lines');
  });

  it('apply_patch with empty patch string shows Edit(unknown)', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'apply_patch',
      toolArgs: { patch: '' },
    });

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\u270F\uFE0F Edit(unknown)');
  });

  it('apply_patch with no patch or diff key shows Edit(unknown)', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'apply_patch',
      toolArgs: { something_else: 'value' },
    });

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\u270F\uFE0F Edit(unknown)');
  });

  // ---------- shortenPath ----------

  it('shortenPath keeps short paths unchanged (2 segments, maxSegments=4)', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'read_file',
      toolArgs: { file_path: '/src/index.ts' },
    });

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCD6 Read(`src/index.ts`)');
  });

  it('shortenPath truncates deeply nested paths to last 4 segments', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'read_file',
      toolArgs: { file_path: '/a/b/c/d/e/f/g.ts' },
    });

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCD6 Read(`d/e/f/g.ts`)');
  });

  it('list_dir shortenPath uses maxSegments=3', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'list_dir',
      toolArgs: { path: '/a/b/c/d/e' },
    });

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCC2 List(`c/d/e`)');
  });

  // ---------- extractCurrentTurnTools ----------

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

    await runHookScript(scriptPath, payload, env());

    // Only 1 tool.activity (from current turn) + 1 session.idle
    expect(requests).toHaveLength(2);
    expect(requests[0].body.type).toBe('tool.activity');
    expect(requests[0].body.text).toBe('\uD83D\uDCBB `echo new`');
    expect(requests[1].body.type).toBe('session.idle');
  });

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

    await runHookScript(scriptPath, payload, env());

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

    await runHookScript(scriptPath, payload, env());

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

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(1);
    expect(requests[0].body.type).toBe('session.idle');
    expect(requests[0].body.text).toBe('Sure, here you go.');
  });

  // ---------- User message handling ----------

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

    await runHookScript(scriptPath, payload, env());

    // Empty user message is skipped as turn boundary, so "First task" is the boundary
    // Both tool calls are after "First task", so both are included
    expect(requests).toHaveLength(3);
    expect(requests[0].body.text).toBe('\uD83D\uDCBB `echo old`');
    expect(requests[1].body.text).toBe('\uD83D\uDCBB `echo new`');
    expect(requests[2].body.type).toBe('session.idle');
  });

  // ---------- safeParse / malformed arguments ----------

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

    await runHookScript(scriptPath, payload, env());

    // safeParse returns {}, no command -> empty format -> skip tool.activity
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

    await runHookScript(scriptPath, payload, env());

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

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.type).toBe('tool.activity');
    expect(requests[0].body.text).toBe('\uD83D\uDCBB `ls`');
  });

  // ---------- git detection ----------

  it('shell with git commit but no matching output falls back to shell format', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'shell',
      toolArgs: { command: ['git', 'commit', '-m', 'test'] },
      toolResult: 'nothing to commit, working tree clean',
    });

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCBB `git commit -m test`');
  });

  it('shell with git push but no matching output falls back to shell format', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'shell',
      toolArgs: { command: ['git', 'push', 'origin', 'main'] },
      toolResult: 'Everything up-to-date',
    });

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCBB `git push origin main`');
  });

  it('git commit with stats including deletions', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'shell',
      toolArgs: { command: 'git commit -m "refactor"' },
      toolResult: '[main def5678] refactor\n 3 files changed, 10 insertions(+), 5 deletions(-)',
    });

    await runHookScript(scriptPath, payload, env());

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

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    const text = requests[0].body.text as string;
    expect(text).toMatch(/^GIT_COMMIT:/);
    const data = JSON.parse(text.slice('GIT_COMMIT:'.length));
    expect(data.hash).toBe('aaa1111');
    expect(data.message).toBe('fix');
  });

  // ---------- read_file / create_file with missing path ----------

  it('read_file with no file_path or path is skipped', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'read_file',
      toolArgs: { something: 'irrelevant' },
    });

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(1);
    expect(requests[0].body.type).toBe('session.idle');
  });

  it('create_file with no file_path or path is skipped', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'create_file',
      toolArgs: { content: 'some content' },
    });

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(1);
    expect(requests[0].body.type).toBe('session.idle');
  });

  it('create_file with empty content shows 0 line count suffix omitted', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'create_file',
      toolArgs: { file_path: '/src/empty.ts', content: '' },
    });

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCDD Write(`src/empty.ts`)');
  });

  // ---------- list_dir defaults ----------

  it('list_dir with no path defaults to "."', async () => {
    const payload = makeToolTurnPayload({
      toolName: 'list_dir',
      toolArgs: {},
    });

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(2);
    expect(requests[0].body.text).toBe('\uD83D\uDCC2 List(`.`)');
  });

  // ---------- tool with no name ----------

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

    await runHookScript(scriptPath, payload, env());

    expect(requests).toHaveLength(1);
    expect(requests[0].body.type).toBe('session.idle');
  });

  // ---------- multiple tool_calls in single assistant message ----------

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

    await runHookScript(scriptPath, payload, env());

    // 2 tool.activity + 1 session.idle
    expect(requests).toHaveLength(3);
    expect(requests[0].body.text).toBe('\uD83D\uDCD6 Read(`src/a.ts`)');
    expect(requests[1].body.text).toBe('\uD83D\uDCD6 Read(`src/b.ts`)');
    expect(requests[2].body.type).toBe('session.idle');
  });
});
