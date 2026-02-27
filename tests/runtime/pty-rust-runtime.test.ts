import { afterEach, describe, expect, it } from 'vitest';
import { PtyRustRuntime } from '../../src/runtime/pty-rust-runtime.js';

const runtimes: PtyRustRuntime[] = [];

function track(runtime: PtyRustRuntime): PtyRustRuntime {
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.dispose('SIGKILL');
  }
});

describe('PtyRustRuntime', () => {
  it('falls back to TS runtime when sidecar is disabled', () => {
    const runtime = track(new PtyRustRuntime({ sidecarDisabled: true, useNodePty: false }));
    const session = runtime.getOrCreateSession('bridge', 'demo');

    expect(session).toBe('bridge');
    expect(runtime.windowExists('bridge', 'demo')).toBe(true);
  });
});
