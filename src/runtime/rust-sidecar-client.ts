import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import type { RuntimeWindowSnapshot } from './pty-runtime.js';
import type { TerminalStyledFrame } from './vt-screen.js';

type SidecarRpcResponse<T = unknown> = {
  ok: boolean;
  result?: T;
  error?: string;
};

type SidecarOptions = {
  binaryPath?: string;
  socketPath?: string;
  startupTimeoutMs?: number;
};

export class RustSidecarClient {
  private binaryPath: string | null;
  private socketPath: string;
  private startupTimeoutMs: number;
  private serverProcess?: ChildProcess;
  private available = false;

  constructor(options?: SidecarOptions) {
    this.binaryPath = resolveSidecarBinaryPath(options?.binaryPath);
    this.socketPath = options?.socketPath || getDefaultRustSidecarSocketPath();
    this.startupTimeoutMs = options?.startupTimeoutMs ?? 1200;

    this.available = this.tryConnectOrStart();
  }

  isAvailable(): boolean {
    return this.available;
  }

  getOrCreateSession(projectName: string, firstWindowName?: string): string {
    const result = this.request<{ sessionName: string }>('get_or_create_session', {
      projectName,
      firstWindowName,
    });
    return result.sessionName;
  }

  setSessionEnv(sessionName: string, key: string, value: string): void {
    this.request('set_session_env', { sessionName, key, value });
  }

  windowExists(sessionName: string, windowName: string): boolean {
    const result = this.request<{ exists: boolean }>('window_exists', { sessionName, windowName });
    return !!result.exists;
  }

  startWindow(sessionName: string, windowName: string, command: string): void {
    this.request('start_window', { sessionName, windowName, command });
  }

  typeKeys(sessionName: string, windowName: string, keys: string): void {
    this.request('type_keys', { sessionName, windowName, keys });
  }

  sendEnter(sessionName: string, windowName: string): void {
    this.request('send_enter', { sessionName, windowName });
  }

  resizeWindow(sessionName: string, windowName: string, cols: number, rows: number): void {
    this.request('resize_window', { sessionName, windowName, cols, rows });
  }

  listWindows(sessionName?: string): RuntimeWindowSnapshot[] {
    const result = this.request<{ windows?: Array<RuntimeWindowSnapshot & {
      startedAt?: number;
      exitedAt?: number;
    }> }>('list_windows', { sessionName });
    return (result.windows || []).map((item) => ({
      sessionName: item.sessionName,
      windowName: item.windowName,
      status: item.status,
      pid: item.pid,
      startedAt: toDate(item.startedAt),
      exitedAt: toDate(item.exitedAt),
      exitCode: item.exitCode,
      signal: item.signal,
    }));
  }

  getWindowBuffer(sessionName: string, windowName: string): string {
    const result = this.request<{ buffer: string }>('get_window_buffer', { sessionName, windowName });
    return result.buffer || '';
  }

  getWindowFrame(
    sessionName: string,
    windowName: string,
    cols?: number,
    rows?: number,
  ): TerminalStyledFrame | null {
    const result = this.request<TerminalStyledFrame>('get_window_frame', {
      sessionName,
      windowName,
      cols,
      rows,
    });
    if (!result || typeof result !== 'object') return null;
    return result;
  }

  stopWindow(sessionName: string, windowName: string): boolean {
    const result = this.request<{ stopped: boolean }>('stop_window', { sessionName, windowName });
    return !!result.stopped;
  }

  dispose(): void {
    if (!this.available || !this.binaryPath) return;
    try {
      this.request('dispose', {});
    } catch {
      // best effort
    }
    if (this.serverProcess && !this.serverProcess.killed) {
      this.serverProcess.kill('SIGTERM');
    }
    this.available = false;
  }

  private tryConnectOrStart(): boolean {
    if (!this.binaryPath) return false;

    try {
      this.request('hello', {}, true);
      return true;
    } catch {
      // try server spawn next
    }

    const parentDir = this.socketPath.slice(0, this.socketPath.lastIndexOf('/'));
    if (parentDir) {
      try {
        mkdirSync(parentDir, { recursive: true });
      } catch {
        // ignore
      }
    }

    try {
      const server = spawn(this.binaryPath, ['server', '--socket', this.socketPath], {
        stdio: 'ignore',
      });
      this.serverProcess = server;
    } catch {
      return false;
    }

    const start = Date.now();
    while (Date.now() - start < this.startupTimeoutMs) {
      try {
        this.request('hello', {}, true);
        return true;
      } catch {
        // retry
      }
    }

    if (this.serverProcess && !this.serverProcess.killed) {
      this.serverProcess.kill('SIGTERM');
    }
    return false;
  }

  private request<T = unknown>(method: string, params?: Record<string, unknown>, ignoreAvailable = false): T {
    if (!ignoreAvailable && (!this.available || !this.binaryPath)) {
      throw new Error('Rust sidecar unavailable');
    }
    if (!this.binaryPath) {
      throw new Error('Rust sidecar binary not configured');
    }

    const commandArgs = [
      'request',
      '--socket',
      this.socketPath,
      '--method',
      method,
      '--params',
      JSON.stringify(params || {}),
    ];

    const result = spawnSync(this.binaryPath, commandArgs, {
      encoding: 'utf8',
      timeout: 1500,
    });

    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || `sidecar request failed (${method})`);
    }

    let payload: SidecarRpcResponse<T>;
    try {
      payload = JSON.parse(result.stdout || '{}') as SidecarRpcResponse<T>;
    } catch {
      throw new Error(`invalid sidecar response for ${method}`);
    }

    if (!payload.ok) {
      throw new Error(payload.error || `sidecar error for ${method}`);
    }

    return payload.result as T;
  }
}

function resolveSidecarBinaryPath(explicitPath?: string): string | null {
  const candidates = [
    explicitPath,
    process.env.DISCODE_PTY_RUST_SIDECAR_BIN,
    join(process.cwd(), 'sidecar', 'pty-rust', 'target', 'release', 'discode-pty-sidecar'),
    join(homedir(), '.discode', 'bin', 'discode-pty-sidecar'),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function toDate(value: number | undefined): Date | undefined {
  if (!value || !Number.isFinite(value)) return undefined;
  return new Date(value * 1000);
}

export function getDefaultRustSidecarSocketPath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\discode-pty-rust';
  }
  return join(tmpdir(), `discode-pty-rust-${process.pid}.sock`);
}
