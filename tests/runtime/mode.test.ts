import { describe, expect, it } from 'vitest';
import { isPtyRuntimeMode, normalizeRuntimeMode, parseRuntimeModeInput } from '../../src/runtime/mode.js';

describe('runtime mode helpers', () => {
  it('normalizes known and unknown runtime mode values', () => {
    expect(normalizeRuntimeMode('tmux')).toBe('tmux');
    expect(normalizeRuntimeMode('pty')).toBe('pty-ts');
    expect(normalizeRuntimeMode('pty-ts')).toBe('pty-ts');
    expect(normalizeRuntimeMode('pty-rust')).toBe('pty-rust');
    expect(normalizeRuntimeMode('something-else')).toBe('tmux');
    expect(normalizeRuntimeMode(undefined)).toBe('tmux');
  });

  it('parses explicit runtime-mode inputs with legacy alias support', () => {
    expect(parseRuntimeModeInput('tmux')).toBe('tmux');
    expect(parseRuntimeModeInput('pty')).toBe('pty-ts');
    expect(parseRuntimeModeInput('pty-ts')).toBe('pty-ts');
    expect(parseRuntimeModeInput('pty-rust')).toBe('pty-rust');
    expect(parseRuntimeModeInput('unknown')).toBeUndefined();
  });

  it('recognizes pty-like runtime modes', () => {
    expect(isPtyRuntimeMode('tmux')).toBe(false);
    expect(isPtyRuntimeMode('pty')).toBe(true);
    expect(isPtyRuntimeMode('pty-ts')).toBe(true);
    expect(isPtyRuntimeMode('pty-rust')).toBe(true);
  });
});
