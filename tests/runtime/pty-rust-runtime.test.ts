import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { PtyRustRuntime } from '../../src/runtime/pty-rust-runtime.js';

const runtimes: PtyRustRuntime[] = [];
const tempDirs: string[] = [];

function track(runtime: PtyRustRuntime): PtyRustRuntime {
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.dispose('SIGKILL');
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('PtyRustRuntime', () => {
  it('requires sidecar and rejects disabled sidecar mode', () => {
    expect(() => new PtyRustRuntime({ sidecarDisabled: true, useNodePty: false })).toThrow(
      /sidecarDisabled is not supported/,
    );
  });

  it('routes runtime operations through sidecar when available', () => {
    const dir = mkdtempSync(join(tmpdir(), 'discode-runtime-sidecar-mock-'));
    tempDirs.push(dir);

    const mockBin = join(dir, 'mock-sidecar.js');
    writeFileSync(
      mockBin,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'server') {
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (args[0] === 'request') {
  const methodIdx = args.indexOf('--method');
  const method = methodIdx >= 0 ? args[methodIdx + 1] : '';
  if (method === 'hello') {
    process.stdout.write(JSON.stringify({ ok: true, id: 1, result: { version: 1 } }));
    process.exit(0);
  }
  if (method === 'health') {
    process.stdout.write(JSON.stringify({ ok: true, id: 1, result: { status: 'ok', version: 1, pid: 1, startedAtUnixMs: 1, uptimeMs: 1, sessions: 1, windows: 1, runningWindows: 1 } }));
    process.exit(0);
  }
  process.stderr.write('unsupported request mode method');
  process.exit(2);
} else if (args[0] === 'client') {
  const readline = require('node:readline');
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const resultFor = (method, params) => {
    if (method === 'hello') return { version: 1 };
    if (method === 'health') return { status: 'ok', version: 1, pid: 101, startedAtUnixMs: 1, uptimeMs: 1, sessions: 1, windows: 1, runningWindows: 1 };
    if (method === 'get_or_create_session') return { sessionName: params.projectName || 'unknown' };
    if (method === 'window_exists') return { exists: false };
    if (method === 'list_windows') return { windows: [{ sessionName: 'bridge', windowName: 'sidecar-win', status: 'running', pid: 777, startedAt: 1710000000 }] };
    if (method === 'get_window_buffer') return { buffer: 'from-sidecar-buffer' };
    if (method === 'get_window_frame') return { cols: 101, rows: 30, lines: [{ segments: [{ text: 'from-sidecar-frame' }] }], cursorRow: 0, cursorCol: 17, cursorVisible: true };
    if (method === 'stop_window') return { stopped: true };
    return { ok: true };
  };
  rl.on('line', (line) => {
    let payload = {};
    try { payload = JSON.parse(line); } catch {
      process.stdout.write(JSON.stringify({ ok: false, error: 'invalid request' }) + '\\n');
      return;
    }
    process.stdout.write(JSON.stringify({ ok: true, id: payload.id, result: resultFor(payload.method || '', payload.params || {}) }) + '\\n');
  });
} else {
  process.stderr.write('unknown command');
  process.exit(1);
}
`,
      'utf8',
    );
    chmodSync(mockBin, 0o755);

    const runtime = track(new PtyRustRuntime({
      sidecarBinary: mockBin,
      sidecarSocketPath: join(dir, 'mock.sock'),
      sidecarStartupTimeoutMs: 250,
      useNodePty: false,
    }));

    expect(runtime.getOrCreateSession('bridge', 'demo')).toBe('bridge');
    expect(runtime.windowExists('bridge', 'demo')).toBe(false);
    expect(runtime.listWindows()).toHaveLength(1);
    expect(runtime.listWindows()[0]?.windowName).toBe('sidecar-win');
    expect(runtime.getWindowBuffer('bridge', 'demo')).toBe('from-sidecar-buffer');
    expect(runtime.getWindowFrame('bridge', 'demo')?.cols).toBe(101);
    expect(runtime.stopWindow('bridge', 'demo')).toBe(true);
  });
});
