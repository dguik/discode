/**
 * Unit tests for PostToolUseFailure support in discode-tool-hook.js.
 *
 * Uses the VM context pattern to test the failure branch.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Script, createContext } from 'vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(__dir, '../../src/claude/plugin/scripts');

function loadLib() {
  const realFs = require('fs');
  const libSrc = readFileSync(join(scriptsDir, 'discode-hook-lib.js'), 'utf-8');
  const libMod = { exports: {} as any };
  new Script(libSrc, { filename: 'discode-hook-lib.js' }).runInContext(createContext({
    require: (m: string) => m === 'fs' ? realFs : {},
    module: libMod, exports: libMod.exports,
    process: { env: {} },
    Buffer, Promise, setTimeout, JSON, Array, Object, Math, Number, String, parseInt, parseFloat,
  }));
  return libMod.exports;
}

function runHook(stdinData: string, env: Record<string, string> = {}, fetchFn?: Function) {
  const hookSrc = readFileSync(join(scriptsDir, 'discode-tool-hook.js'), 'utf-8');
  const lib = loadLib();
  const fetchCalls: any[] = [];
  const mockFetch = fetchFn || (async (url: string, opts: any) => {
    fetchCalls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true };
  });

  let stdinResolve: (v: string) => void;
  const stdinPromise = new Promise<string>((r) => { stdinResolve = r; });
  const mockReadStdin = () => { stdinResolve!(stdinData); return stdinPromise; };
  const mockPostToBridge = async (port: string, payload: any) => {
    const url = `http://127.0.0.1:${port}/opencode-event`;
    return mockFetch(url, { body: JSON.stringify(payload) });
  };

  const patchedLib = { ...lib, readStdin: mockReadStdin, postToBridge: mockPostToBridge };

  const ctx = createContext({
    require: (mod: string) => {
      if (mod === './discode-hook-lib.js' || mod === './discode-hook-lib') return patchedLib;
      return {};
    },
    process: { env: { DISCODE_PROJECT: 'test', DISCODE_PORT: '18470', ...env } },
    console: { error: () => {} },
    Promise,
    setTimeout,
    Buffer,
    fetch: mockFetch,
    JSON, Array, Object, Math, Number, String, parseInt, parseFloat,
  });

  new Script(hookSrc, { filename: 'discode-tool-hook.js' }).runInContext(ctx);

  return new Promise<typeof fetchCalls>((resolve) => {
    setTimeout(() => resolve(fetchCalls), 50);
  });
}

describe('discode-tool-hook — PostToolUseFailure', () => {
  it('sends tool.failure event with toolName and error', async () => {
    const calls = await runHook(JSON.stringify({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      error: 'Command failed with exit code 1',
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0].body.type).toBe('tool.failure');
    expect(calls[0].body.toolName).toBe('Bash');
    expect(calls[0].body.error).toBe('Command failed with exit code 1');
    expect(calls[0].body.projectName).toBe('test');
  });

  it('truncates error to 150 characters', async () => {
    const longError = 'E'.repeat(200);
    const calls = await runHook(JSON.stringify({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      error: longError,
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0].body.error).toBe('E'.repeat(150) + '...');
  });

  it('does nothing when tool_name is missing', async () => {
    const calls = await runHook(JSON.stringify({
      hook_event_name: 'PostToolUseFailure',
      error: 'some error',
    }));
    expect(calls).toHaveLength(0);
  });

  it('sends error as empty string when missing', async () => {
    const calls = await runHook(JSON.stringify({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Edit',
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0].body.error).toBe('');
  });

  it('does not interfere with PostToolUse (existing behavior)', async () => {
    const calls = await runHook(JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
      tool_response: 'file1\nfile2',
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0].body.type).toBe('tool.activity');
    expect(calls[0].body.text).toContain('ls -la');
  });

  it('does nothing when DISCODE_PROJECT is empty', async () => {
    const calls = await runHook(
      JSON.stringify({
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        error: 'fail',
      }),
      { DISCODE_PROJECT: '' },
    );
    expect(calls).toHaveLength(0);
  });

  it('ignores fetch failures silently', async () => {
    const failFetch = async () => { throw new Error('network error'); };
    const calls = await runHook(
      JSON.stringify({
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        error: 'fail',
      }),
      {},
      failFetch,
    );
    expect(calls).toHaveLength(0);
  });

  it('includes instanceId when set', async () => {
    const calls = await runHook(
      JSON.stringify({
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        error: 'fail',
      }),
      { DISCODE_INSTANCE: 'inst-2' },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].body.instanceId).toBe('inst-2');
  });
});
