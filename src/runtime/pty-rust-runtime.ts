import { PtyRuntime } from './pty-runtime.js';
import type { RuntimeWindowSnapshot } from './pty-runtime.js';
import type { TerminalStyledFrame } from './vt-screen.js';
import { RustSidecarClient } from './rust-sidecar-client.js';

export type PtyRustRuntimeOptions = {
  sidecarBinary?: string;
  sidecarSocketPath?: string;
  sidecarStartupTimeoutMs?: number;
  sidecarDisabled?: boolean;
  shell?: string;
  maxBufferBytes?: number;
  useNodePty?: boolean;
};

export class PtyRustRuntime extends PtyRuntime {
  private sidecar?: RustSidecarClient;
  private sidecarActive = false;

  constructor(options?: PtyRustRuntimeOptions) {
    super(options);
    if (options?.sidecarDisabled) {
      throw new Error('pty-rust runtime requires sidecar; sidecarDisabled is not supported');
    }

    this.sidecar = new RustSidecarClient({
      binaryPath: options?.sidecarBinary,
      socketPath: options?.sidecarSocketPath,
      startupTimeoutMs: options?.sidecarStartupTimeoutMs,
    });
    this.sidecarActive = this.sidecar.isAvailable();
    if (!this.sidecarActive) {
      const metrics = this.sidecar.getStartupMetrics();
      const detail = metrics.reason ? ` (${metrics.reason})` : '';
      throw new Error(`pty-rust sidecar unavailable${detail}`);
    }
    console.warn('[runtime] pty-rust mode enabled; sidecar connected');
  }

  override getOrCreateSession(projectName: string, firstWindowName?: string): string {
    return this.requireSidecar().getOrCreateSession(projectName, firstWindowName);
  }

  override setSessionEnv(sessionName: string, key: string, value: string): void {
    this.requireSidecar().setSessionEnv(sessionName, key, value);
  }

  override windowExists(sessionName: string, windowName: string): boolean {
    return this.requireSidecar().windowExists(sessionName, windowName);
  }

  override startAgentInWindow(sessionName: string, windowName: string, agentCommand: string): void {
    this.requireSidecar().startWindow(sessionName, windowName, agentCommand);
  }

  override typeKeysToWindow(sessionName: string, windowName: string, keys: string): void {
    this.requireSidecar().typeKeys(sessionName, windowName, keys);
  }

  override sendEnterToWindow(sessionName: string, windowName: string): void {
    this.requireSidecar().sendEnter(sessionName, windowName);
  }

  override resizeWindow(sessionName: string, windowName: string, cols: number, rows: number): void {
    this.requireSidecar().resizeWindow(sessionName, windowName, cols, rows);
  }

  override listWindows(sessionName?: string): RuntimeWindowSnapshot[] {
    return this.requireSidecar().listWindows(sessionName);
  }

  override getWindowBuffer(sessionName: string, windowName: string): string {
    return this.requireSidecar().getWindowBuffer(sessionName, windowName);
  }

  override getWindowFrame(
    sessionName: string,
    windowName: string,
    cols?: number,
    rows?: number,
  ): TerminalStyledFrame | null {
    return this.requireSidecar().getWindowFrame(sessionName, windowName, cols, rows);
  }

  override stopWindow(sessionName: string, windowName: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    void signal;
    return this.requireSidecar().stopWindow(sessionName, windowName);
  }

  override dispose(signal: NodeJS.Signals = 'SIGTERM'): void {
    void signal;
    if (this.sidecarActive) {
      try {
        this.sidecar?.dispose();
      } catch {
        // best effort
      }
      this.sidecarActive = false;
    }
  }

  private requireSidecar(): RustSidecarClient {
    if (!this.sidecar || !this.sidecarActive) {
      throw new Error('pty-rust sidecar unavailable');
    }
    return this.sidecar;
  }
}
