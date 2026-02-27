import type { AgentRuntime } from './interface.js';
import type { TerminalStyledFrame } from './vt-screen.js';
import type { RuntimeWindowRef } from './window-id.js';

export type RuntimeWindowSummary = {
  sessionName: string;
  windowName: string;
  status?: string;
  pid?: number;
  startedAt?: Date;
  exitedAt?: Date;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
};

export interface RuntimeWindowApi {
  start(ref: RuntimeWindowRef, command: string): void;
  input(ref: RuntimeWindowRef, bytes: string): void;
  submit(ref: RuntimeWindowRef): void;
  resize(ref: RuntimeWindowRef, cols: number, rows: number): void;
  getFrame(ref: RuntimeWindowRef, cols?: number, rows?: number): TerminalStyledFrame | null;
  getBuffer(ref: RuntimeWindowRef): string;
  stop(ref: RuntimeWindowRef, signal?: NodeJS.Signals): boolean;
  exists(ref: RuntimeWindowRef): boolean;
  list(sessionName?: string): RuntimeWindowSummary[];
}

export function createRuntimeWindowApi(runtime: AgentRuntime): RuntimeWindowApi {
  return {
    start(ref, command) {
      runtime.startAgentInWindow(ref.sessionName, ref.windowName, command);
    },
    input(ref, bytes) {
      runtime.typeKeysToWindow(ref.sessionName, ref.windowName, bytes);
    },
    submit(ref) {
      runtime.sendEnterToWindow(ref.sessionName, ref.windowName);
    },
    resize(ref, cols, rows) {
      runtime.resizeWindow?.(ref.sessionName, ref.windowName, cols, rows);
    },
    getFrame(ref, cols, rows) {
      return runtime.getWindowFrame?.(ref.sessionName, ref.windowName, cols, rows) || null;
    },
    getBuffer(ref) {
      if (!runtime.getWindowBuffer) {
        throw new Error('Runtime control unavailable');
      }
      return runtime.getWindowBuffer(ref.sessionName, ref.windowName);
    },
    stop(ref, signal) {
      if (!runtime.stopWindow) {
        throw new Error('Runtime stop unavailable');
      }
      if (signal === undefined) {
        return runtime.stopWindow(ref.sessionName, ref.windowName);
      }
      return runtime.stopWindow(ref.sessionName, ref.windowName, signal);
    },
    exists(ref) {
      return runtime.windowExists(ref.sessionName, ref.windowName);
    },
    list(sessionName) {
      if (!runtime.listWindows) return [];
      return runtime.listWindows(sessionName);
    },
  };
}
