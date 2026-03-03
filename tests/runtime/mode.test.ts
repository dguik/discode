import { describe, expect, it } from 'vitest';
import { isPtyRuntimeMode, normalizeRuntimeMode, parseRuntimeModeInput } from '../../src/runtime/mode.js';

describe('runtime mode helpers', () => {
  it('normalizes known and unknown runtime mode values', () => {
    expect(normalizeRuntimeMode('tmux')).toBe('tmux');
    expect(normalizeRuntimeMode('pty-rust')).toBe('pty-rust');
    expect(normalizeRuntimeMode('something-else')).toBe('tmux');
    expect(normalizeRuntimeMode(undefined)).toBe('tmux');
  });

  it('parses explicit runtime-mode inputs', () => {
    expect(parseRuntimeModeInput('tmux')).toBe('tmux');
    expect(parseRuntimeModeInput('pty-rust')).toBe('pty-rust');
    expect(parseRuntimeModeInput('unknown')).toBeUndefined();
  });

  it('recognizes only pty-rust as pty runtime mode', () => {
    expect(isPtyRuntimeMode('tmux')).toBe(false);
    expect(isPtyRuntimeMode('pty-rust')).toBe(true);
  });
});
