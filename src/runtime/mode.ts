import type { RuntimeMode } from '../types/index.js';

export type RuntimeModeInput = RuntimeMode | 'pty';

export function normalizeRuntimeMode(value: unknown): RuntimeMode {
  if (value === 'pty-rust') return 'pty-rust';
  if (value === 'pty-ts' || value === 'pty') return 'pty-ts';
  return 'tmux';
}

export function parseRuntimeModeInput(value: unknown): RuntimeMode | undefined {
  if (value === 'tmux' || value === 'pty-ts' || value === 'pty-rust') return value;
  if (value === 'pty') return 'pty-ts';
  return undefined;
}

export function isPtyRuntimeMode(mode: RuntimeModeInput | undefined): boolean {
  return mode === 'pty-ts' || mode === 'pty-rust' || mode === 'pty';
}
