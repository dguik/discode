import type { AgentRuntime } from './interface.js';
import { RUNTIME_CONTROL_PROTOCOL_VERSION } from './protocol.js';
import { createRuntimeWindowApi, type RuntimeWindowApi } from './window-api.js';
import { parseRuntimeWindowId, toRuntimeWindowId } from './window-id.js';

export type RuntimeWindowView = {
  windowId: string;
  sessionName: string;
  windowName: string;
  status?: string;
  pid?: number;
  startedAt?: Date;
  exitedAt?: Date;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
};

export class RuntimeControlPlane {
  private activeWindowId?: string;
  private runtimeApi?: RuntimeWindowApi;
  private enabled: boolean;

  constructor(runtime?: AgentRuntime) {
    this.runtimeApi = runtime ? createRuntimeWindowApi(runtime) : undefined;
    this.enabled = !!runtime?.listWindows && !!runtime?.getWindowBuffer;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  listWindows(): { protocolVersion: number; activeWindowId?: string; windows: RuntimeWindowView[] } {
    if (!this.runtimeApi || !this.enabled) {
      return { protocolVersion: RUNTIME_CONTROL_PROTOCOL_VERSION, activeWindowId: undefined, windows: [] };
    }

    const windows = this.runtimeApi.list().map((window) => ({
      windowId: toRuntimeWindowId({ sessionName: window.sessionName, windowName: window.windowName }),
      sessionName: window.sessionName,
      windowName: window.windowName,
      status: window.status,
      pid: window.pid,
      startedAt: window.startedAt,
      exitedAt: window.exitedAt,
      exitCode: window.exitCode,
      signal: window.signal,
    }));

    if (windows.length === 0) {
      this.activeWindowId = undefined;
      return { protocolVersion: RUNTIME_CONTROL_PROTOCOL_VERSION, activeWindowId: undefined, windows };
    }

    if (!this.activeWindowId || !windows.some((window) => window.windowId === this.activeWindowId)) {
      this.activeWindowId = windows[0].windowId;
    }

    return {
      protocolVersion: RUNTIME_CONTROL_PROTOCOL_VERSION,
      activeWindowId: this.activeWindowId,
      windows,
    };
  }

  focusWindow(windowId: string): boolean {
    if (!this.runtimeApi || !this.enabled) return false;
    const parsed = parseRuntimeWindowId(windowId);
    if (!parsed) return false;
    if (!this.runtimeApi.exists(parsed)) return false;

    this.activeWindowId = toRuntimeWindowId(parsed);
    return true;
  }

  getActiveWindowId(): string | undefined {
    return this.activeWindowId;
  }

  sendInput(params: {
    windowId?: string;
    text?: string;
    submit?: boolean;
  }): { windowId: string } {
    if (!this.runtimeApi || !this.enabled) {
      throw new Error('Runtime control unavailable');
    }

    const targetWindowId = params.windowId || this.activeWindowId;
    if (!targetWindowId) {
      throw new Error('Missing windowId');
    }

    const parsed = parseRuntimeWindowId(targetWindowId);
    if (!parsed) {
      throw new Error('Invalid windowId');
    }

    if (!this.runtimeApi.exists(parsed)) {
      throw new Error('Window not found');
    }

    const text = typeof params.text === 'string' ? params.text : '';
    const submit = params.submit !== false;

    if (text.length > 0) {
      this.runtimeApi.input(parsed, text);
    }
    if (submit) {
      this.runtimeApi.submit(parsed);
    }

    this.activeWindowId = toRuntimeWindowId(parsed);
    return { windowId: this.activeWindowId };
  }

  getBuffer(windowId: string, since: number = 0): {
    protocolVersion: number;
    windowId: string;
    since: number;
    next: number;
    chunk: string;
  } {
    if (!this.runtimeApi || !this.enabled) {
      throw new Error('Runtime control unavailable');
    }

    const parsed = parseRuntimeWindowId(windowId);
    if (!parsed) {
      throw new Error('Invalid windowId');
    }

    if (!this.runtimeApi.exists(parsed)) {
      throw new Error('Window not found');
    }

    const raw = this.runtimeApi.getBuffer(parsed);
    const safeSince = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0;
    const start = Math.min(safeSince, raw.length);
    const chunk = raw.slice(start);

    return {
      protocolVersion: RUNTIME_CONTROL_PROTOCOL_VERSION,
      windowId: toRuntimeWindowId(parsed),
      since: start,
      next: raw.length,
      chunk,
    };
  }

  stopWindow(windowId: string): boolean {
    if (!this.runtimeApi || !this.enabled) {
      throw new Error('Runtime stop unavailable');
    }

    const parsed = parseRuntimeWindowId(windowId);
    if (!parsed) {
      throw new Error('Invalid windowId');
    }

    if (!this.runtimeApi.exists(parsed)) {
      throw new Error('Window not found');
    }

    const stopped = this.runtimeApi.stop(parsed);
    if (!stopped) {
      throw new Error('Failed to stop window');
    }
    return true;
  }
}
