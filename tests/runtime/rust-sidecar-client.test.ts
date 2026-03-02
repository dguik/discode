import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { RustSidecarClient } from '../../src/runtime/rust-sidecar-client.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('RustSidecarClient', () => {
  it('connects to sidecar RPC helper and maps responses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'discode-sidecar-mock-'));
    tempDirs.push(dir);

    const mockBin = join(dir, 'mock-sidecar.js');
    writeFileSync(
      mockBin,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const getFlag = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
};
if (args[0] === 'server') {
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (args[0] === 'request' || args[0] === 'client') {
  const buildResult = (method, params) => {
  let result = {};
  if (method === 'hello') result = { version: 1 };
  else if (method === 'get_or_create_session') result = { sessionName: params.projectName || 'unknown' };
  else if (method === 'window_exists') result = { exists: true };
  else if (method === 'list_windows') result = {
    windows: [{
      sessionName: 'bridge',
      windowName: 'demo',
      status: 'running',
      pid: 123,
      startedAt: 1710000000,
    }],
  };
  else if (method === 'get_window_buffer') result = { buffer: 'hello from sidecar' };
  else if (method === 'get_window_frame') result = {
    cols: 80,
    rows: 24,
    lines: [{ segments: [{ text: 'line' }] }],
    cursorRow: 0,
    cursorCol: 4,
    cursorVisible: true,
  };
  else if (method === 'health') result = {
    status: 'ok',
    version: 1,
    pid: 999,
    startedAtUnixMs: 1710000000000,
    uptimeMs: 123,
    sessions: 1,
    windows: 1,
    runningWindows: 1,
    rpc: {
      requestsTotal: 7,
      errorsTotal: 0,
      methods: {
        health: {
          requests: 2,
          errors: 0,
          lastLatencyMs: 1,
          avgLatencyMs: 1,
          maxLatencyMs: 1,
          lastErrorCode: null,
        },
      },
    },
  };
  else if (method === 'stop_window') result = { stopped: true };
  else result = { ok: true };

  return result;
  };

  if (args[0] === 'request') {
    const method = getFlag('--method');
    const paramsRaw = getFlag('--params') || '{}';
    let params = {};
    try { params = JSON.parse(paramsRaw); } catch {}

    if (method !== 'hello') {
      process.stderr.write('request mode only supports hello');
      process.exit(2);
    }

    process.stdout.write(JSON.stringify({ ok: true, result: buildResult(method, params) }));
  } else {
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (line) => {
      let payload = {};
      try { payload = JSON.parse(line); } catch {
        process.stdout.write(JSON.stringify({ ok: false, error: 'invalid request' }) + '\\n');
        return;
      }
      const method = payload.method || '';
      const params = payload.params || {};
      process.stdout.write(JSON.stringify({ ok: true, result: buildResult(method, params) }) + '\\n');
    });
  }
} else {
  process.stderr.write('unknown command');
  process.exit(1);
}
`,
      'utf8',
    );
    chmodSync(mockBin, 0o755);

    const client = new RustSidecarClient({
      binaryPath: mockBin,
      socketPath: join(dir, 'mock.sock'),
      startupTimeoutMs: 200,
    });

    expect(client.isAvailable()).toBe(true);
    expect(client.getStartupMetrics().strategy).not.toBe('unavailable');
    expect(client.getOrCreateSession('bridge', 'demo')).toBe('bridge');
    expect(client.windowExists('bridge', 'demo')).toBe(true);
    expect(client.health().status).toBe('ok');
    expect(client.health().rpc?.requestsTotal).toBeGreaterThan(0);
    expect(client.listWindows()).toHaveLength(1);
    expect(client.getWindowBuffer('bridge', 'demo')).toContain('sidecar');
    expect(client.getWindowFrame('bridge', 'demo')?.cols).toBe(80);
    expect(client.stopWindow('bridge', 'demo')).toBe(true);

    client.dispose();
  });
});
