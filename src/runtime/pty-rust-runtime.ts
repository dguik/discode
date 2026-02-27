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
  private warnedFallback = false;

  constructor(options?: PtyRustRuntimeOptions) {
    super(options);
    if (options?.sidecarDisabled) {
      this.warnFallback('sidecar disabled by option');
      return;
    }

    try {
      this.sidecar = new RustSidecarClient({
        binaryPath: options?.sidecarBinary,
        socketPath: options?.sidecarSocketPath,
        startupTimeoutMs: options?.sidecarStartupTimeoutMs,
      });
      this.sidecarActive = this.sidecar.isAvailable();
      if (this.sidecarActive) {
        console.warn('[runtime] pty-rust mode enabled (PoC); sidecar connected');
      } else {
        this.warnFallback('sidecar unavailable');
      }
    } catch (error) {
      this.warnFallback(error instanceof Error ? error.message : String(error));
    }
  }

  override getOrCreateSession(projectName: string, firstWindowName?: string): string {
    return this.useSidecar(
      () => this.sidecar!.getOrCreateSession(projectName, firstWindowName),
      () => super.getOrCreateSession(projectName, firstWindowName),
    );
  }

  override setSessionEnv(sessionName: string, key: string, value: string): void {
    this.useSidecar(
      () => this.sidecar!.setSessionEnv(sessionName, key, value),
      () => super.setSessionEnv(sessionName, key, value),
    );
  }

  override windowExists(sessionName: string, windowName: string): boolean {
    return this.useSidecar(
      () => this.sidecar!.windowExists(sessionName, windowName),
      () => super.windowExists(sessionName, windowName),
    );
  }

  override startAgentInWindow(sessionName: string, windowName: string, agentCommand: string): void {
    this.useSidecar(
      () => this.sidecar!.startWindow(sessionName, windowName, agentCommand),
      () => super.startAgentInWindow(sessionName, windowName, agentCommand),
    );
  }

  override typeKeysToWindow(sessionName: string, windowName: string, keys: string): void {
    this.useSidecar(
      () => this.sidecar!.typeKeys(sessionName, windowName, keys),
      () => super.typeKeysToWindow(sessionName, windowName, keys),
    );
  }

  override sendEnterToWindow(sessionName: string, windowName: string): void {
    this.useSidecar(
      () => this.sidecar!.sendEnter(sessionName, windowName),
      () => super.sendEnterToWindow(sessionName, windowName),
    );
  }

  override resizeWindow(sessionName: string, windowName: string, cols: number, rows: number): void {
    this.useSidecar(
      () => this.sidecar!.resizeWindow(sessionName, windowName, cols, rows),
      () => super.resizeWindow(sessionName, windowName, cols, rows),
    );
  }

  override listWindows(sessionName?: string): RuntimeWindowSnapshot[] {
    return this.useSidecar(
      () => this.sidecar!.listWindows(sessionName),
      () => super.listWindows(sessionName),
    );
  }

  override getWindowBuffer(sessionName: string, windowName: string): string {
    return this.useSidecar(
      () => this.sidecar!.getWindowBuffer(sessionName, windowName),
      () => super.getWindowBuffer(sessionName, windowName),
    );
  }

  override getWindowFrame(
    sessionName: string,
    windowName: string,
    cols?: number,
    rows?: number,
  ): TerminalStyledFrame | null {
    return this.useSidecar(
      () => this.sidecar!.getWindowFrame(sessionName, windowName, cols, rows),
      () => super.getWindowFrame(sessionName, windowName, cols, rows),
    );
  }

  override stopWindow(sessionName: string, windowName: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    return this.useSidecar(
      () => this.sidecar!.stopWindow(sessionName, windowName),
      () => super.stopWindow(sessionName, windowName, signal),
    );
  }

  override dispose(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.sidecarActive) {
      try {
        this.sidecar?.dispose();
      } catch {
        // best effort
      }
      this.sidecarActive = false;
    }
    super.dispose(signal);
  }

  private useSidecar<T>(runSidecar: () => T, runFallback: () => T): T {
    if (!this.sidecarActive || !this.sidecar) {
      return runFallback();
    }

    try {
      return runSidecar();
    } catch (error) {
      this.sidecarActive = false;
      this.warnFallback(`sidecar request failed: ${error instanceof Error ? error.message : String(error)}`);
      return runFallback();
    }
  }

  private warnFallback(reason: string): void {
    if (this.warnedFallback) return;
    this.warnedFallback = true;
    console.warn(`[runtime] pty-rust mode enabled (PoC); using TS fallback implementation (${reason})`);
  }
}
