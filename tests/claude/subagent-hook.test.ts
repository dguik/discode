/**
 * Unit tests for the SubagentStop hook script (discode-subagent-hook.js).
 *
 * Uses the same VM-based CJS testing pattern as tool-hook.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Script, createContext } from 'vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const hookPath = join(__dir, '../../src/claude/plugin/scripts/discode-subagent-hook.js');

type TruncateFn = (str: string, maxLen: number) => string;

function loadHookFunctions() {
  const raw = readFileSync(hookPath, 'utf-8');
  // Strip the self-executing main() so it doesn't run
  const src = raw.replace(/main\(\)\.catch[\s\S]*$/, '');

  const ctx = createContext({
    require: () => ({}),
    process: { env: {}, stdin: { isTTY: true } },
    console: { error: () => {} },
    Promise,
    setTimeout,
    Buffer,
    fetch: async () => ({}),
    JSON,
    Array,
    Object,
    String,
    RegExp,
  });

  new Script(src, { filename: 'discode-subagent-hook.js' }).runInContext(ctx);

  return {
    truncate: (ctx as any).truncate as TruncateFn,
    main: (ctx as any).main as () => Promise<void>,
    postToBridge: (ctx as any).postToBridge as (port: string, payload: unknown) => Promise<void>,
  };
}

const { truncate } = loadHookFunctions();

// ── truncate ────────────────────────────────────────────────────────

describe('truncate', () => {
  it('returns first two non-empty lines joined by space', () => {
    expect(truncate('line one\nline two\nline three', 200)).toBe('line one line two');
  });

  it('truncates to maxLen with ellipsis', () => {
    const long = 'A'.repeat(250);
    const result = truncate(long, 200);
    expect(result).toHaveLength(203); // 200 + "..."
    expect(result).toMatch(/\.\.\.$/);
  });

  it('returns empty string for empty input', () => {
    expect(truncate('', 200)).toBe('');
  });

  it('returns empty string for null/undefined', () => {
    expect(truncate(null as any, 200)).toBe('');
    expect(truncate(undefined as any, 200)).toBe('');
  });

  it('filters blank lines', () => {
    expect(truncate('  \n\nactual content\n  \n', 200)).toBe('actual content');
  });

  it('trims outer whitespace but preserves inner spaces', () => {
    // truncate trims the full string + result, but not individual lines
    expect(truncate('  hello  \n  world  ', 200)).toBe('hello     world');
  });

  it('takes only first two lines', () => {
    expect(truncate('one\ntwo\nthree\nfour', 200)).toBe('one two');
  });

  it('handles single line within maxLen', () => {
    expect(truncate('short', 200)).toBe('short');
  });

  it('handles exactly maxLen characters', () => {
    const exact = 'A'.repeat(200);
    expect(truncate(exact, 200)).toBe(exact);
  });

  it('returns first line only when second line is empty', () => {
    expect(truncate('only line\n\n', 200)).toBe('only line');
  });
});

// ── integration: main() with simulated environment ──────────────────

describe('subagent-hook integration', () => {
  function runHook(opts: {
    env?: Record<string, string>;
    stdinData?: string;
    fetchMock?: (url: string, init: any) => Promise<any>;
  }) {
    const raw = readFileSync(hookPath, 'utf-8');
    const src = raw.replace(/main\(\)\.catch[\s\S]*$/, '');

    const fetchCalls: Array<{ url: string; body: any }> = [];
    const ctx = createContext({
      require: () => ({}),
      process: {
        env: opts.env || {},
        stdin: {
          isTTY: false,
          setEncoding: () => {},
          on: (event: string, cb: (data?: string) => void) => {
            if (event === 'data' && opts.stdinData) cb(opts.stdinData);
            if (event === 'end') setTimeout(() => cb(), 0);
          },
        },
      },
      console: { error: () => {} },
      Promise,
      setTimeout,
      Buffer,
      fetch: opts.fetchMock || (async (url: string, init: any) => {
        fetchCalls.push({ url, body: JSON.parse(init.body) });
        return { ok: true };
      }),
      JSON,
      Array,
      Object,
      String,
      RegExp,
    });

    new Script(src, { filename: 'discode-subagent-hook.js' }).runInContext(ctx);

    return { ctx, fetchCalls, main: (ctx as any).main as () => Promise<void> };
  }

  it('posts SUBAGENT_DONE event with truncated summary', async () => {
    const { main, fetchCalls } = runHook({
      env: {
        DISCODE_PROJECT: 'myproject',
        DISCODE_AGENT: 'claude',
        DISCODE_PORT: '9999',
      },
      stdinData: JSON.stringify({
        agent_type: 'Explore',
        last_assistant_message: 'Found 14 matching files in src/runtime/',
      }),
    });

    await main();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('http://127.0.0.1:9999/opencode-event');
    expect(fetchCalls[0].body.projectName).toBe('myproject');
    expect(fetchCalls[0].body.agentType).toBe('claude');
    expect(fetchCalls[0].body.type).toBe('tool.activity');
    expect(fetchCalls[0].body.text).toContain('SUBAGENT_DONE:');

    const parsed = JSON.parse(fetchCalls[0].body.text.slice('SUBAGENT_DONE:'.length));
    expect(parsed.subagentType).toBe('Explore');
    expect(parsed.summary).toBe('Found 14 matching files in src/runtime/');
  });

  it('uses legacy env vars as fallback', async () => {
    const { main, fetchCalls } = runHook({
      env: {
        AGENT_DISCORD_PROJECT: 'legacyproj',
        AGENT_DISCORD_AGENT: 'codex',
        AGENT_DISCORD_PORT: '8888',
        AGENT_DISCORD_HOSTNAME: '192.168.1.1',
      },
      stdinData: JSON.stringify({
        agent_type: 'Bash',
        last_assistant_message: 'Tests passed',
      }),
    });

    await main();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('http://192.168.1.1:8888/opencode-event');
    expect(fetchCalls[0].body.projectName).toBe('legacyproj');
    expect(fetchCalls[0].body.agentType).toBe('codex');
  });

  it('includes instanceId when set', async () => {
    const { main, fetchCalls } = runHook({
      env: {
        DISCODE_PROJECT: 'proj',
        DISCODE_INSTANCE: 'inst-42',
        DISCODE_PORT: '9999',
      },
      stdinData: JSON.stringify({
        agent_type: 'Plan',
        last_assistant_message: 'Plan complete',
      }),
    });

    await main();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.instanceId).toBe('inst-42');
  });

  it('skips when project is not set', async () => {
    const { main, fetchCalls } = runHook({
      env: {},
      stdinData: JSON.stringify({
        agent_type: 'Explore',
        last_assistant_message: 'Found stuff',
      }),
    });

    await main();
    expect(fetchCalls).toHaveLength(0);
  });

  it('skips when summary is empty', async () => {
    const { main, fetchCalls } = runHook({
      env: { DISCODE_PROJECT: 'proj', DISCODE_PORT: '9999' },
      stdinData: JSON.stringify({
        agent_type: 'Explore',
        last_assistant_message: '',
      }),
    });

    await main();
    expect(fetchCalls).toHaveLength(0);
  });

  it('skips when last_assistant_message is missing', async () => {
    const { main, fetchCalls } = runHook({
      env: { DISCODE_PROJECT: 'proj', DISCODE_PORT: '9999' },
      stdinData: JSON.stringify({ agent_type: 'Explore' }),
    });

    await main();
    expect(fetchCalls).toHaveLength(0);
  });

  it('defaults agent_type to "unknown" when missing', async () => {
    const { main, fetchCalls } = runHook({
      env: { DISCODE_PROJECT: 'proj', DISCODE_PORT: '9999' },
      stdinData: JSON.stringify({
        last_assistant_message: 'Done with work',
      }),
    });

    await main();

    expect(fetchCalls).toHaveLength(1);
    const parsed = JSON.parse(fetchCalls[0].body.text.slice('SUBAGENT_DONE:'.length));
    expect(parsed.subagentType).toBe('unknown');
  });

  it('handles malformed stdin JSON gracefully', async () => {
    const { main, fetchCalls } = runHook({
      env: { DISCODE_PROJECT: 'proj', DISCODE_PORT: '9999' },
      stdinData: '{not valid json',
    });

    await main();
    expect(fetchCalls).toHaveLength(0);
  });

  it('truncates long multi-line messages', async () => {
    const longMessage = 'First line of output\nSecond line of output\nThird line ignored\nFourth line ignored';
    const { main, fetchCalls } = runHook({
      env: { DISCODE_PROJECT: 'proj', DISCODE_PORT: '9999' },
      stdinData: JSON.stringify({
        agent_type: 'Explore',
        last_assistant_message: longMessage,
      }),
    });

    await main();

    const parsed = JSON.parse(fetchCalls[0].body.text.slice('SUBAGENT_DONE:'.length));
    expect(parsed.summary).toBe('First line of output Second line of output');
  });

  it('ignores fetch errors silently', async () => {
    const { main } = runHook({
      env: { DISCODE_PROJECT: 'proj', DISCODE_PORT: '9999' },
      stdinData: JSON.stringify({
        agent_type: 'Explore',
        last_assistant_message: 'Found stuff',
      }),
      fetchMock: async () => { throw new Error('Connection refused'); },
    });

    // Should not throw
    await main();
  });

  it('omits instanceId when not set', async () => {
    const { main, fetchCalls } = runHook({
      env: { DISCODE_PROJECT: 'proj', DISCODE_PORT: '9999' },
      stdinData: JSON.stringify({
        agent_type: 'Explore',
        last_assistant_message: 'Found stuff',
      }),
    });

    await main();

    expect(fetchCalls[0].body).not.toHaveProperty('instanceId');
  });
});
