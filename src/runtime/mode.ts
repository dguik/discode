import type { RuntimeMode } from '../types/index.js';

export type RuntimeModeInput = RuntimeMode;

export function normalizeRuntimeMode(value: unknown): RuntimeMode {
  if (value === 'pty-rust') return 'pty-rust';
  return 'tmux';
}

export function parseRuntimeModeInput(value: unknown): RuntimeMode | undefined {
  if (value === 'tmux' || value === 'pty-rust') return value;
  return undefined;
}

export function isPtyRuntimeMode(mode: RuntimeModeInput | undefined): boolean {
  return mode === 'pty-rust';
}
