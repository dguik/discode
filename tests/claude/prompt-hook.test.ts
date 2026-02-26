/**
 * Unit tests for the UserPromptSubmit hook script (discode-prompt-hook.js).
 *
 * Uses the VM context pattern to load the CJS script and test the main() flow.
 */

import { describe, expect, it, vi } from 'vitest';
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
  const hookSrc = readFileSync(join(scriptsDir, 'discode-prompt-hook.js'), 'utf-8');
  const lib = loadLib();
  const fetchCalls: any[] = [];
  const failMode = !!fetchFn;
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

  new Script(hookSrc, { filename: 'discode-prompt-hook.js' }).runInContext(ctx);

  return new Promise<typeof fetchCalls>((resolve) => {
    setTimeout(() => resolve(fetchCalls), 50);
  });
}

describe('discode-prompt-hook (UserPromptSubmit)', () => {
  it('sends prompt.submit event with prompt text', async () => {
    const calls = await runHook(JSON.stringify({ prompt: 'Fix the login bug' }));
    expect(calls).toHaveLength(1);
    expect(calls[0].body.type).toBe('prompt.submit');
    expect(calls[0].body.text).toBe('Fix the login bug');
    expect(calls[0].body.projectName).toBe('test');
  });

  it('truncates prompt to 200 characters', async () => {
    const longPrompt = 'A'.repeat(250);
    const calls = await runHook(JSON.stringify({ prompt: longPrompt }));
    expect(calls).toHaveLength(1);
    expect(calls[0].body.text).toBe('A'.repeat(200) + '...');
  });

  it('does nothing when DISCODE_PROJECT is empty', async () => {
    const calls = await runHook(
      JSON.stringify({ prompt: 'hello' }),
      { DISCODE_PROJECT: '' },
    );
    expect(calls).toHaveLength(0);
  });

  it('does nothing when prompt is empty', async () => {
    const calls = await runHook(JSON.stringify({ prompt: '' }));
    expect(calls).toHaveLength(0);
  });

  it('does nothing when prompt is missing', async () => {
    const calls = await runHook(JSON.stringify({}));
    expect(calls).toHaveLength(0);
  });

  it('handles malformed JSON gracefully', async () => {
    const calls = await runHook('not json');
    expect(calls).toHaveLength(0);
  });

  it('ignores fetch failures', async () => {
    const failFetch = async () => { throw new Error('network error'); };
    const calls = await runHook(
      JSON.stringify({ prompt: 'test' }),
      {},
      failFetch,
    );
    // Should not throw — the hook silently ignores delivery failures
    expect(calls).toHaveLength(0);
  });

  it('includes instanceId when set', async () => {
    const calls = await runHook(
      JSON.stringify({ prompt: 'test' }),
      { DISCODE_INSTANCE: 'inst-1' },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].body.instanceId).toBe('inst-1');
  });

  it('trims whitespace-only prompt', async () => {
    const calls = await runHook(JSON.stringify({ prompt: '   ' }));
    expect(calls).toHaveLength(0);
  });
});
