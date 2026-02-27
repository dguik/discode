import { describe, expect, it } from 'vitest';
import { isPtyRuntimeMode, normalizeRuntimeMode } from '../../src/runtime/mode.js';

describe('runtime mode helpers', () => {
  it('normalizes known and unknown runtime mode values', () => {
    expect(normalizeRuntimeMode('tmux')).toBe('tmux');
    expect(normalizeRuntimeMode('pty')).toBe('pty');
    expect(normalizeRuntimeMode('pty-rust')).toBe('pty-rust');
    expect(normalizeRuntimeMode('something-else')).toBe('tmux');
    expect(normalizeRuntimeMode(undefined)).toBe('tmux');
  });

  it('recognizes pty-like runtime modes', () => {
    expect(isPtyRuntimeMode('tmux')).toBe(false);
    expect(isPtyRuntimeMode('pty')).toBe(true);
    expect(isPtyRuntimeMode('pty-rust')).toBe(true);
  });
});
