import type { RuntimeMode } from '../types/index.js';
import type { AgentRuntime } from './interface.js';
import { PtyRustRuntime } from './pty-rust-runtime.js';
import { TmuxRuntime } from './tmux-runtime.js';

export function createRuntimeForMode(mode: RuntimeMode | undefined, sessionPrefix: string): AgentRuntime {
  if (mode === 'pty-rust') {
    return new PtyRustRuntime();
  }
  return TmuxRuntime.create(sessionPrefix);
}
