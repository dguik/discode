import { describe, expect, it } from 'vitest';
import { parseRuntimeWindowId, toRuntimeWindowId } from '../../src/runtime/window-id.js';

describe('runtime window id helpers', () => {
  it('builds and parses canonical window IDs', () => {
    const windowId = toRuntimeWindowId({ sessionName: 'bridge', windowName: 'demo-opencode' });
    expect(windowId).toBe('bridge:demo-opencode');
    expect(parseRuntimeWindowId(windowId)).toEqual({ sessionName: 'bridge', windowName: 'demo-opencode' });
  });

  it('rejects invalid window IDs', () => {
    expect(parseRuntimeWindowId('')).toBeNull();
    expect(parseRuntimeWindowId('no-colon')).toBeNull();
    expect(parseRuntimeWindowId(':window')).toBeNull();
    expect(parseRuntimeWindowId('session:')).toBeNull();
  });
});
