/**
 * Unit tests for the Claude Code session-hook script.
 *
 * Handles both SessionStart and SessionEnd events via hook_event_name.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Script, createContext } from 'vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(__dir, '../../src/claude/plugin/scripts');
const hookPath = join(scriptsDir, 'discode-session-hook.js');

function loadLib(overrides: { process?: any; fetch?: any } = {}) {
  const realFs = require('fs');
  const libSrc = readFileSync(join(scriptsDir, 'discode-hook-lib.js'), 'utf-8');
  const libMod = { exports: {} as any };
  new Script(libSrc, { filename: 'discode-hook-lib.js' }).runInContext(createContext({
    require: (m: string) => m === 'fs' ? realFs : {},
    module: libMod, exports: libMod.exports,
    process: overrides.process || { env: {} },
    fetch: overrides.fetch || (async () => ({})),
    Buffer, Promise, setTimeout, JSON, Array, Object, String, Number,
  }));
  return libMod.exports;
}

function runHook(env: Record<string, string>, stdinJson: unknown): Promise<{ calls: Array<{ url: string; body: unknown }> }> {
  return new Promise((resolve) => {
    const raw = readFileSync(hookPath, 'utf-8');
    const fetchCalls: Array<{ url: string; body: unknown }> = [];

    const stdinData = JSON.stringify(stdinJson);
    let onData: ((chunk: string) => void) | null = null;
    let onEnd: (() => void) | null = null;

    const mockProcess = {
      env,
      stdin: {
        isTTY: false,
        setEncoding: () => {},
        on: (event: string, cb: any) => {
          if (event === 'data') onData = cb;
          if (event === 'end') onEnd = cb;
        },
      },
    };
    const mockFetch = async (url: string, opts: any) => {
      fetchCalls.push({ url, body: JSON.parse(opts.body) });
      return {};
    };

    const lib = loadLib({ process: mockProcess, fetch: mockFetch });
    const ctx = createContext({
      require: (mod: string) => {
        if (mod === './discode-hook-lib.js' || mod === './discode-hook-lib') return lib;
        return {};
      },
      process: mockProcess,
      console: { error: () => {} },
      Promise,
      setTimeout,
      JSON,
      Array,
      Object,
      String,
      Number,
      fetch: mockFetch,
    });

    new Script(raw, { filename: 'discode-session-hook.js' }).runInContext(ctx);

    // Simulate stdin delivery
    setTimeout(() => {
      if (onData) onData(stdinData);
      if (onEnd) onEnd();
      // Wait for async main() to complete
      setTimeout(() => resolve({ calls: fetchCalls }), 50);
    }, 10);
  });
}

describe('discode-session-hook', () => {
  describe('SessionStart', () => {
    it('posts session.start event with source and model', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'myproject', DISCODE_PORT: '18470' },
        { hook_event_name: 'SessionStart', source: 'startup', model: 'claude-sonnet-4-6' },
      );

      expect(result.calls).toHaveLength(1);
      const payload = result.calls[0].body as Record<string, unknown>;
      expect(payload.type).toBe('session.start');
      expect(payload.projectName).toBe('myproject');
      expect(payload.agentType).toBe('claude');
      expect(payload.source).toBe('startup');
      expect(payload.model).toBe('claude-sonnet-4-6');
    });

    it('handles resume source', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        { hook_event_name: 'SessionStart', source: 'resume', model: 'claude-opus-4-6' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).source).toBe('resume');
      expect((result.calls[0].body as any).model).toBe('claude-opus-4-6');
    });

    it('handles clear source', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        { hook_event_name: 'SessionStart', source: 'clear', model: 'claude-sonnet-4-6' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).source).toBe('clear');
    });

    it('handles compact source', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        { hook_event_name: 'SessionStart', source: 'compact', model: 'claude-sonnet-4-6' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).source).toBe('compact');
    });

    it('handles missing model field', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        { hook_event_name: 'SessionStart', source: 'startup' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).model).toBe('');
    });

    it('handles missing source field', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        { hook_event_name: 'SessionStart' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).source).toBe('unknown');
    });

    it('includes instanceId when set', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470', DISCODE_INSTANCE: 'inst-2' },
        { hook_event_name: 'SessionStart', source: 'startup', model: 'claude-sonnet-4-6' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).instanceId).toBe('inst-2');
    });

    it('omits instanceId when DISCODE_INSTANCE is empty', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470', DISCODE_INSTANCE: '' },
        { hook_event_name: 'SessionStart', source: 'startup' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).instanceId).toBeUndefined();
    });
  });

  describe('SessionEnd', () => {
    it('posts session.end event with reason', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'myproject', DISCODE_PORT: '18470' },
        { hook_event_name: 'SessionEnd', reason: 'logout' },
      );

      expect(result.calls).toHaveLength(1);
      const payload = result.calls[0].body as Record<string, unknown>;
      expect(payload.type).toBe('session.end');
      expect(payload.projectName).toBe('myproject');
      expect(payload.agentType).toBe('claude');
      expect(payload.reason).toBe('logout');
    });

    it('handles prompt_input_exit reason', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).reason).toBe('prompt_input_exit');
    });

    it('handles clear reason', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        { hook_event_name: 'SessionEnd', reason: 'clear' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).reason).toBe('clear');
    });

    it('handles bypass_permissions_disabled reason', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        { hook_event_name: 'SessionEnd', reason: 'bypass_permissions_disabled' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).reason).toBe('bypass_permissions_disabled');
    });

    it('handles other reason', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        { hook_event_name: 'SessionEnd', reason: 'other' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).reason).toBe('other');
    });

    it('handles missing reason field', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        { hook_event_name: 'SessionEnd' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).reason).toBe('unknown');
    });

    it('includes instanceId when set', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470', DISCODE_INSTANCE: 'inst-3' },
        { hook_event_name: 'SessionEnd', reason: 'logout' },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).instanceId).toBe('inst-3');
    });
  });

  it('does nothing when DISCODE_PROJECT is not set', async () => {
    const result = await runHook(
      { DISCODE_PORT: '18470' },
      { hook_event_name: 'SessionStart', source: 'startup' },
    );

    expect(result.calls).toHaveLength(0);
  });

  it('does nothing for unknown hook_event_name', async () => {
    const result = await runHook(
      { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
      { hook_event_name: 'UnknownEvent' },
    );

    expect(result.calls).toHaveLength(0);
  });

  it('does nothing for missing hook_event_name', async () => {
    const result = await runHook(
      { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
      { source: 'startup' },
    );

    expect(result.calls).toHaveLength(0);
  });

  it('uses custom DISCODE_AGENT', async () => {
    const result = await runHook(
      { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470', DISCODE_AGENT: 'codex' },
      { hook_event_name: 'SessionStart', source: 'startup' },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).agentType).toBe('codex');
  });

  it('uses custom DISCODE_HOSTNAME in fetch URL', async () => {
    const result = await runHook(
      { DISCODE_PROJECT: 'proj', DISCODE_PORT: '9999', DISCODE_HOSTNAME: '10.0.0.1' },
      { hook_event_name: 'SessionEnd', reason: 'logout' },
    );

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].url).toBe('http://10.0.0.1:9999/opencode-event');
  });

  it('handles malformed JSON stdin gracefully', async () => {
    const raw = readFileSync(hookPath, 'utf-8');
    const fetchCalls: Array<{ url: string; body: unknown }> = [];
    let onData: ((chunk: string) => void) | null = null;
    let onEnd: (() => void) | null = null;

    const mockProcess = {
      env: { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
      stdin: {
        isTTY: false,
        setEncoding: () => {},
        on: (event: string, cb: any) => {
          if (event === 'data') onData = cb;
          if (event === 'end') onEnd = cb;
        },
      },
    };
    const mockFetch = async (url: string, opts: any) => {
      fetchCalls.push({ url, body: JSON.parse(opts.body) });
      return {};
    };
    const lib = loadLib({ process: mockProcess, fetch: mockFetch });
    const ctx = createContext({
      require: (mod: string) => {
        if (mod === './discode-hook-lib.js' || mod === './discode-hook-lib') return lib;
        return {};
      },
      process: mockProcess,
      console: { error: () => {} },
      Promise,
      setTimeout,
      JSON,
      Array,
      Object,
      String,
      Number,
      fetch: mockFetch,
    });

    new Script(raw, { filename: 'discode-session-hook.js' }).runInContext(ctx);

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (onData) onData('not valid json {{{');
        if (onEnd) onEnd();
        setTimeout(() => resolve(), 50);
      }, 10);
    });

    // With malformed JSON, hook_event_name is empty -> does nothing
    expect(fetchCalls).toHaveLength(0);
  });

  it('does nothing when DISCODE_PROJECT is not set (SessionEnd)', async () => {
    const result = await runHook(
      { DISCODE_PORT: '18470' },
      { hook_event_name: 'SessionEnd', reason: 'logout' },
    );

    expect(result.calls).toHaveLength(0);
  });

  it('silently ignores fetch failure for SessionEnd', async () => {
    const raw = readFileSync(hookPath, 'utf-8');
    const stdinData = JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'logout' });
    let onData: ((chunk: string) => void) | null = null;
    let onEnd: (() => void) | null = null;

    const mockProcess = {
      env: { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
      stdin: {
        isTTY: false,
        setEncoding: () => {},
        on: (event: string, cb: any) => {
          if (event === 'data') onData = cb;
          if (event === 'end') onEnd = cb;
        },
      },
    };
    const mockFetch = async () => { throw new Error('network error'); };
    const lib = loadLib({ process: mockProcess, fetch: mockFetch });
    const ctx = createContext({
      require: (mod: string) => {
        if (mod === './discode-hook-lib.js' || mod === './discode-hook-lib') return lib;
        return {};
      },
      process: mockProcess,
      console: { error: () => {} },
      Promise,
      setTimeout,
      JSON,
      Array,
      Object,
      String,
      Number,
      fetch: mockFetch,
    });

    new Script(raw, { filename: 'discode-session-hook.js' }).runInContext(ctx);

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (onData) onData(stdinData);
        if (onEnd) onEnd();
        setTimeout(() => resolve(), 50);
      }, 10);
    });

    // Test passes if no unhandled rejection
  });

  it('silently ignores fetch failure for SessionStart', async () => {
    const raw = readFileSync(hookPath, 'utf-8');
    const stdinData = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' });
    let onData: ((chunk: string) => void) | null = null;
    let onEnd: (() => void) | null = null;

    const mockProcess = {
      env: { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
      stdin: {
        isTTY: false,
        setEncoding: () => {},
        on: (event: string, cb: any) => {
          if (event === 'data') onData = cb;
          if (event === 'end') onEnd = cb;
        },
      },
    };
    const mockFetch = async () => { throw new Error('network error'); };
    const lib = loadLib({ process: mockProcess, fetch: mockFetch });
    const ctx = createContext({
      require: (mod: string) => {
        if (mod === './discode-hook-lib.js' || mod === './discode-hook-lib') return lib;
        return {};
      },
      process: mockProcess,
      console: { error: () => {} },
      Promise,
      setTimeout,
      JSON,
      Array,
      Object,
      String,
      Number,
      fetch: mockFetch,
    });

    new Script(raw, { filename: 'discode-session-hook.js' }).runInContext(ctx);

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (onData) onData(stdinData);
        if (onEnd) onEnd();
        setTimeout(() => resolve(), 50);
      }, 10);
    });

    // Test passes if no unhandled rejection
  });
});
