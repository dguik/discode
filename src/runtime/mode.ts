import type { RuntimeMode } from '../types/index.js';

export function normalizeRuntimeMode(value: unknown): RuntimeMode {
  if (value === 'pty-rust') return 'pty-rust';
  if (value === 'pty') return 'pty';
  return 'tmux';
}

export function isPtyRuntimeMode(mode: RuntimeMode | undefined): boolean {
  return mode === 'pty' || mode === 'pty-rust';
}
