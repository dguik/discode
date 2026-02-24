import { afterEach, describe, expect, it } from 'vitest';
import { PtyRuntime } from '../../src/runtime/pty-runtime.js';
import { VtScreen } from '../../src/runtime/vt-screen.js';
import { buildTerminalResponse } from '../../src/runtime/pty-query-handler.js';

const runtimes: PtyRuntime[] = [];

function track(runtime: PtyRuntime): PtyRuntime {
  runtimes.push(runtime);
  return runtime;
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.dispose('SIGKILL');
  }
});

describe('PtyRuntime', () => {
  it('starts a process with session env and captures output', async () => {
    const runtime = track(new PtyRuntime());

    runtime.getOrCreateSession('bridge', 'claude');
    runtime.setSessionEnv('bridge', 'DISCODE_PORT', '18470');
    runtime.startAgentInWindow('bridge', 'claude', 'printf "%s\\n" "$DISCODE_PORT"');

    await waitFor(() => {
      const window = runtime.listWindows('bridge').find((item) => item.windowName === 'claude');
      return !!window && window.status !== 'starting' && window.status !== 'running';
    });

    const buffer = runtime.getWindowBuffer('bridge', 'claude');
    expect(buffer).toContain('18470');
  });

  it('routes input to running window and stops process', async () => {
    const runtime = track(new PtyRuntime());

    runtime.getOrCreateSession('bridge', 'opencode');
    runtime.startAgentInWindow('bridge', 'opencode', 'cat');

    await waitFor(() => {
      const window = runtime.listWindows('bridge').find((item) => item.windowName === 'opencode');
      return window?.status === 'running';
    });

    runtime.sendKeysToWindow('bridge', 'opencode', 'hello-runtime');

    await waitFor(() => runtime.getWindowBuffer('bridge', 'opencode').includes('hello-runtime'));

    expect(runtime.stopWindow('bridge', 'opencode')).toBe(true);
    await waitFor(() => {
      const window = runtime.listWindows('bridge').find((item) => item.windowName === 'opencode');
      return !!window && window.status !== 'running' && window.status !== 'starting';
    });
  });

  it('answers common terminal queries for interactive CLIs', () => {
    track(new PtyRuntime({ useNodePty: false }));

    const record = {
      screen: new VtScreen(20, 6),
      queryCarry: '',
      privateModes: new Map<number, boolean>(),
    };

    record.screen.write('abc');
    expect(buildTerminalResponse(record, '\x1b[6n')).toBe('\x1b[1;4R');
    expect(buildTerminalResponse(record, '\x1b[?6n')).toBe('\x1b[?1;4R');
    expect(buildTerminalResponse(record, '\x1b[5n')).toBe('\x1b[0n');
  });

  it('reports default and explicit private mode states', () => {
    track(new PtyRuntime({ useNodePty: false }));

    const record = {
      screen: new VtScreen(20, 6),
      queryCarry: '',
      privateModes: new Map<number, boolean>(),
    };

    // Cursor visibility mode is commonly enabled by default.
    expect(buildTerminalResponse(record, '\x1b[?25$p')).toBe('\x1b[?25;1$y');

    record.privateModes.set(2004, true);
    expect(buildTerminalResponse(record, '\x1b[?2004$p')).toBe('\x1b[?2004;1$y');
  });

  it('responds to OSC color queries used by terminal-aware tools', () => {
    track(new PtyRuntime({ useNodePty: false }));

    const record = {
      screen: new VtScreen(20, 6),
      queryCarry: '',
      privateModes: new Map<number, boolean>(),
    };

    const fg = buildTerminalResponse(record, '\x1b]10;?\x07');
    const bg = buildTerminalResponse(record, '\x1b]11;?\x07');
    const indexed = buildTerminalResponse(record, '\x1b]4;12;?\x07');

    expect(fg).toMatch(/^\x1b]10;rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}\x07$/);
    expect(bg).toMatch(/^\x1b]11;rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}\x07$/);
    expect(indexed).toMatch(/^\x1b]4;12;rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}\x07$/);
  });
});
