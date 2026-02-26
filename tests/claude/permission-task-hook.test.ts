/**
 * Unit tests for the Claude Code permission-task-hook script.
 *
 * Handles PermissionRequest and TaskCompleted events via hook_event_name.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Script, createContext } from 'vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(__dir, '../../src/claude/plugin/scripts');
const hookPath = join(scriptsDir, 'discode-permission-task-hook.js');

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

    new Script(raw, { filename: 'discode-permission-task-hook.js' }).runInContext(ctx);

    setTimeout(() => {
      if (onData) onData(stdinData);
      if (onEnd) onEnd();
      setTimeout(() => resolve({ calls: fetchCalls }), 50);
    }, 10);
  });
}

describe('discode-permission-task-hook', () => {
  describe('PermissionRequest', () => {
    it('posts permission.request event with toolName and toolInput', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'myproject', DISCODE_PORT: '18470' },
        {
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
        },
      );

      expect(result.calls).toHaveLength(1);
      const payload = result.calls[0].body as Record<string, unknown>;
      expect(payload.type).toBe('permission.request');
      expect(payload.projectName).toBe('myproject');
      expect(payload.agentType).toBe('claude');
      expect(payload.toolName).toBe('Bash');
      expect(payload.toolInput).toBe('npm test');
    });

    it('truncates Bash command to 100 characters', async () => {
      const longCommand = 'a'.repeat(150);
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        {
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: longCommand },
        },
      );

      expect(result.calls).toHaveLength(1);
      const payload = result.calls[0].body as Record<string, unknown>;
      expect(payload.toolInput).toBe('a'.repeat(100) + '...');
    });

    it('extracts file_path for Edit tool', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        {
          hook_event_name: 'PermissionRequest',
          tool_name: 'Edit',
          tool_input: { file_path: '/src/index.ts', old_string: 'foo', new_string: 'bar' },
        },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).toolInput).toBe('/src/index.ts');
    });

    it('extracts file_path for Write tool', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        {
          hook_event_name: 'PermissionRequest',
          tool_name: 'Write',
          tool_input: { file_path: '/src/new.ts', content: 'hello' },
        },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).toolInput).toBe('/src/new.ts');
    });

    it('extracts file_path for Read tool', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        {
          hook_event_name: 'PermissionRequest',
          tool_name: 'Read',
          tool_input: { file_path: '/src/config.json' },
        },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).toolInput).toBe('/src/config.json');
    });

    it('extracts first field value for unknown tools', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        {
          hook_event_name: 'PermissionRequest',
          tool_name: 'CustomTool',
          tool_input: { query: 'search term', limit: 10 },
        },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).toolInput).toBe('search term');
    });

    it('handles empty tool_input', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        {
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: {},
        },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).toolInput).toBe('');
    });

    it('handles missing tool_input', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        {
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
        },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).toolInput).toBe('');
    });

    it('includes instanceId when set', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470', DISCODE_INSTANCE: 'inst-5' },
        {
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
        },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).instanceId).toBe('inst-5');
    });

    it('omits instanceId when DISCODE_INSTANCE is empty', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470', DISCODE_INSTANCE: '' },
        {
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
        },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).instanceId).toBeUndefined();
    });
  });

  describe('TaskCompleted', () => {
    it('posts task.completed event with taskId and taskSubject', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'myproject', DISCODE_PORT: '18470' },
        {
          hook_event_name: 'TaskCompleted',
          task_id: 'task-42',
          task_subject: 'Fix login bug',
          teammate_name: '',
        },
      );

      expect(result.calls).toHaveLength(1);
      const payload = result.calls[0].body as Record<string, unknown>;
      expect(payload.type).toBe('task.completed');
      expect(payload.projectName).toBe('myproject');
      expect(payload.agentType).toBe('claude');
      expect(payload.taskId).toBe('task-42');
      expect(payload.taskSubject).toBe('Fix login bug');
      expect(payload.teammateName).toBeUndefined();
    });

    it('includes teammateName when provided', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        {
          hook_event_name: 'TaskCompleted',
          task_id: 'task-1',
          task_subject: 'Write tests',
          teammate_name: 'agent-2',
        },
      );

      expect(result.calls).toHaveLength(1);
      const payload = result.calls[0].body as Record<string, unknown>;
      expect(payload.teammateName).toBe('agent-2');
    });

    it('handles missing teammateName', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470' },
        {
          hook_event_name: 'TaskCompleted',
          task_id: 'task-1',
          task_subject: 'Deploy',
        },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).teammateName).toBeUndefined();
    });

    it('includes instanceId when set', async () => {
      const result = await runHook(
        { DISCODE_PROJECT: 'proj', DISCODE_PORT: '18470', DISCODE_INSTANCE: 'inst-7' },
        {
          hook_event_name: 'TaskCompleted',
          task_id: 'task-1',
          task_subject: 'Done',
        },
      );

      expect(result.calls).toHaveLength(1);
      expect((result.calls[0].body as any).instanceId).toBe('inst-7');
    });
  });

  it('does nothing when DISCODE_PROJECT is not set', async () => {
    const result = await runHook(
      { DISCODE_PORT: '18470' },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } },
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
      { tool_name: 'Bash' },
    );

    expect(result.calls).toHaveLength(0);
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

    new Script(raw, { filename: 'discode-permission-task-hook.js' }).runInContext(ctx);

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (onData) onData('not valid json {{{');
        if (onEnd) onEnd();
        setTimeout(() => resolve(), 50);
      }, 10);
    });

    expect(fetchCalls).toHaveLength(0);
  });

  it('uses legacy AGENT_DISCORD_PROJECT env var', async () => {
    const result = await runHook(
      { AGENT_DISCORD_PROJECT: 'legacy-proj', DISCODE_PORT: '18470' },
      {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      },
    );

    expect(result.calls).toHaveLength(1);
    expect((result.calls[0].body as any).projectName).toBe('legacy-proj');
  });

  it('silently ignores fetch failure for PermissionRequest', async () => {
    const raw = readFileSync(hookPath, 'utf-8');
    const stdinData = JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } });
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

    new Script(raw, { filename: 'discode-permission-task-hook.js' }).runInContext(ctx);

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (onData) onData(stdinData);
        if (onEnd) onEnd();
        setTimeout(() => resolve(), 50);
      }, 10);
    });

    // Test passes if no unhandled rejection
  });

  it('silently ignores fetch failure for TaskCompleted', async () => {
    const raw = readFileSync(hookPath, 'utf-8');
    const stdinData = JSON.stringify({ hook_event_name: 'TaskCompleted', task_id: 'task-1', task_subject: 'Done' });
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

    new Script(raw, { filename: 'discode-permission-task-hook.js' }).runInContext(ctx);

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
