import type { RuntimeMode } from '../types/index.js';
import type { AgentRuntime } from './interface.js';
import { PtyRuntime } from './pty-runtime.js';
import { PtyRustRuntime } from './pty-rust-runtime.js';
import { TmuxRuntime } from './tmux-runtime.js';

export function createRuntimeForMode(mode: RuntimeMode | undefined, sessionPrefix: string): AgentRuntime {
  if (mode === 'pty-rust') {
    return new PtyRustRuntime();
  }
  if (mode === 'pty-ts') {
    return new PtyRuntime();
  }
  return TmuxRuntime.create(sessionPrefix);
}
