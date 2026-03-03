import type { AgentRuntime } from './interface.js';
import type { RuntimeWindowSnapshot } from './window-types.js';
import type { TerminalStyledFrame } from './vt-screen.js';
import type { SidecarHealthSnapshot, SidecarStartupMetrics } from './rust-sidecar-client.js';
import { RustSidecarClient } from './rust-sidecar-client.js';
import { recordTelemetryEvents } from '../telemetry/index.js';

export type PtyRustRuntimeOptions = {
  sidecarBinary?: string;
  sidecarSocketPath?: string;
  sidecarStartupTimeoutMs?: number;
  sidecarDisabled?: boolean;
  shell?: string;
  maxBufferBytes?: number;
  useNodePty?: boolean;
};

export class PtyRustRuntime implements AgentRuntime {
  private sidecar?: RustSidecarClient;
  private sidecarActive = false;

  constructor(options?: PtyRustRuntimeOptions) {
    if (options?.sidecarDisabled) {
      throw new Error('pty-rust runtime requires sidecar; sidecarDisabled is not supported');
    }

    this.sidecar = new RustSidecarClient({
      binaryPath: options?.sidecarBinary,
      socketPath: options?.sidecarSocketPath,
      startupTimeoutMs: options?.sidecarStartupTimeoutMs,
    });
    this.sidecarActive = this.sidecar.isAvailable();
    const startupMetrics = this.sidecar.getStartupMetrics();
    if (!this.sidecarActive) {
      this.emitStartupTelemetry(startupMetrics, null, false);
      const detail = startupMetrics.reason ? ` (${startupMetrics.reason})` : '';
      throw new Error(`pty-rust sidecar unavailable${detail}`);
    }
    console.warn('[runtime] pty-rust mode enabled; sidecar connected');
    this.emitStartupTelemetry(startupMetrics, this.readHealthSnapshot(), true);
  }

  getOrCreateSession(projectName: string, firstWindowName?: string): string {
    return this.requireSidecar().getOrCreateSession(projectName, firstWindowName);
  }

  setSessionEnv(sessionName: string, key: string, value: string): void {
    this.requireSidecar().setSessionEnv(sessionName, key, value);
  }

  windowExists(sessionName: string, windowName: string): boolean {
    return this.requireSidecar().windowExists(sessionName, windowName);
  }

  startAgentInWindow(sessionName: string, windowName: string, agentCommand: string): void {
    this.requireSidecar().startWindow(sessionName, windowName, agentCommand);
  }

  sendKeysToWindow(sessionName: string, windowName: string, keys: string): void {
    this.typeKeysToWindow(sessionName, windowName, keys);
    this.sendEnterToWindow(sessionName, windowName);
  }

  typeKeysToWindow(sessionName: string, windowName: string, keys: string): void {
    this.requireSidecar().typeKeys(sessionName, windowName, keys);
  }

  sendEnterToWindow(sessionName: string, windowName: string): void {
    this.requireSidecar().sendEnter(sessionName, windowName);
  }

  resizeWindow(sessionName: string, windowName: string, cols: number, rows: number): void {
    this.requireSidecar().resizeWindow(sessionName, windowName, cols, rows);
  }

  listWindows(sessionName?: string): RuntimeWindowSnapshot[] {
    return this.requireSidecar().listWindows(sessionName);
  }

  getWindowBuffer(sessionName: string, windowName: string): string {
    return this.requireSidecar().getWindowBuffer(sessionName, windowName);
  }

  getWindowFrame(
    sessionName: string,
    windowName: string,
    cols?: number,
    rows?: number,
  ): TerminalStyledFrame | null {
    return this.requireSidecar().getWindowFrame(sessionName, windowName, cols, rows);
  }

  stopWindow(sessionName: string, windowName: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    void signal;
    return this.requireSidecar().stopWindow(sessionName, windowName);
  }

  dispose(signal: NodeJS.Signals = 'SIGTERM'): void {
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

  private readHealthSnapshot(): SidecarHealthSnapshot | null {
    try {
      return this.requireSidecar().health();
    } catch {
      return null;
    }
  }

  private emitStartupTelemetry(
    startupMetrics: SidecarStartupMetrics,
    health: SidecarHealthSnapshot | null,
    success: boolean,
  ): void {
    void recordTelemetryEvents([
      {
        name: 'pty_rust_runtime_startup',
        params: {
          success,
          strategy: startupMetrics.strategy,
          startup_duration_ms: startupMetrics.durationMs,
          startup_attempts: startupMetrics.attempts,
          startup_reason: startupMetrics.reason,
          health_ok: health?.status === 'ok',
          health_uptime_ms: health?.uptimeMs,
          health_windows: health?.windows,
          health_running_windows: health?.runningWindows,
          rpc_requests_total: health?.rpc?.requestsTotal,
          rpc_errors_total: health?.rpc?.errorsTotal,
        },
      },
    ]);
  }
}
