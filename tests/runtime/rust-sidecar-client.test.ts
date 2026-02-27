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
} else if (args[0] === 'request') {
  const method = getFlag('--method');
  const paramsRaw = getFlag('--params') || '{}';
  let params = {};
  try { params = JSON.parse(paramsRaw); } catch {}

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
  else if (method === 'stop_window') result = { stopped: true };
  else result = { ok: true };

  process.stdout.write(JSON.stringify({ ok: true, result }));
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
    expect(client.getOrCreateSession('bridge', 'demo')).toBe('bridge');
    expect(client.windowExists('bridge', 'demo')).toBe(true);
    expect(client.listWindows()).toHaveLength(1);
    expect(client.getWindowBuffer('bridge', 'demo')).toContain('sidecar');
    expect(client.getWindowFrame('bridge', 'demo')?.cols).toBe(80);
    expect(client.stopWindow('bridge', 'demo')).toBe(true);

    client.dispose();
  });
});
