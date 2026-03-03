import { existsSync, mkdirSync, readSync, writeSync } from 'fs';
import { join } from 'path';
import { arch as osArch, homedir, platform as osPlatform, tmpdir } from 'os';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import type { RuntimeWindowSnapshot } from './window-types.js';
import type { TerminalStyledFrame } from './vt-screen.js';

type SidecarRpcResponse<T = unknown> = {
  ok: boolean;
  id?: number;
  result?: T;
  error?: string | { code?: string; message?: string };
};

type SidecarOptions = {
  binaryPath?: string;
  socketPath?: string;
  startupTimeoutMs?: number;
};

export type SidecarHealthSnapshot = {
  status: string;
  version: number;
  pid: number;
  startedAtUnixMs: number;
  uptimeMs: number;
  sessions: number;
  windows: number;
  runningWindows: number;
  rpc?: {
    requestsTotal: number;
    errorsTotal: number;
    methods: Record<string, {
      requests: number;
      errors: number;
      lastLatencyMs: number;
      avgLatencyMs: number;
      maxLatencyMs: number;
      lastErrorCode: string | null;
    }>;
  };
};

export type SidecarStartupMetrics = {
  strategy: 'bridge-existing' | 'request-existing' | 'spawned-server' | 'unavailable';
  durationMs: number;
  attempts: number;
  reason?: string;
};

export class RustSidecarClient {
  private binaryPath: string | null;
  private socketPath: string;
  private startupTimeoutMs: number;
  private serverProcess?: ChildProcess;
  private clientProcess?: ChildProcess;
  private clientStdinFd?: number;
  private clientStdoutFd?: number;
  private clientReadBuffer = Buffer.alloc(0);
  private requestTimeoutMs = 1500;
  private nextRequestId = 1;
  private available = false;
  private startupMetrics: SidecarStartupMetrics = {
    strategy: 'unavailable',
    durationMs: 0,
    attempts: 0,
  };

  constructor(options?: SidecarOptions) {
    this.binaryPath = resolveSidecarBinaryPath(options?.binaryPath);
    this.socketPath = options?.socketPath || getDefaultRustSidecarSocketPath();
    this.startupTimeoutMs = options?.startupTimeoutMs ?? 1200;

    this.available = this.tryConnectOrStart();
  }

  isAvailable(): boolean {
    return this.available;
  }

  health(): SidecarHealthSnapshot {
    return this.request<SidecarHealthSnapshot>('health', {});
  }

  getStartupMetrics(): SidecarStartupMetrics {
    return { ...this.startupMetrics };
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
    const result = this.request<{
      windows?: Array<RuntimeWindowSnapshot & {
        startedAt?: number;
        exitedAt?: number;
      }>;
    }>('list_windows', { sessionName });
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
    if (this.available && this.binaryPath) {
      try {
        this.request('dispose', {});
      } catch {
        // best effort
      }
    }

    this.stopClientBridge();

    if (this.serverProcess && !this.isProcessExited(this.serverProcess)) {
      if (!this.waitForProcessExit(this.serverProcess, 300)) {
        this.serverProcess.kill('SIGTERM');
        if (!this.waitForProcessExit(this.serverProcess, 300)) {
          this.serverProcess.kill('SIGKILL');
        }
      }
    }
    this.serverProcess = undefined;

    this.available = false;
  }

  private tryConnectOrStart(): boolean {
    const startedAt = Date.now();
    this.startupMetrics.attempts = 0;
    if (!this.binaryPath) {
      this.markStartupFailure(startedAt, 'binary not found');
      return false;
    }

    if (this.startClientBridge()) {
      try {
        this.probeBridgeReady();
        this.markStartupSuccess('bridge-existing', startedAt);
        return true;
      } catch {
        this.stopClientBridge();
      }
    }

    try {
      this.probeCommandReady();
      this.markStartupSuccess('request-existing', startedAt);
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
      if (!this.startClientBridge()) {
        try {
          this.probeCommandReady();
          return true;
        } catch {
          continue;
        }
      }

      try {
        this.probeBridgeReady();
        this.markStartupSuccess('spawned-server', startedAt);
        return true;
      } catch {
        this.stopClientBridge();
      }
    }

    if (this.serverProcess && !this.serverProcess.killed) {
      this.serverProcess.kill('SIGTERM');
    }

    this.markStartupFailure(startedAt, 'startup timeout');

    return false;
  }

  private startClientBridge(): boolean {
    if (this.clientProcess && !this.clientProcess.killed && this.clientStdinFd !== undefined && this.clientStdoutFd !== undefined) {
      return true;
    }

    if (!this.binaryPath) return false;

    this.stopClientBridge();

    let bridge: ChildProcess;
    try {
      bridge = spawn(this.binaryPath, ['client', '--socket', this.socketPath], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      return false;
    }

    const stdinFd = getStreamFd(bridge.stdin as unknown as { _handle?: { fd?: number } });
    const stdoutFd = getStreamFd(bridge.stdout as unknown as { _handle?: { fd?: number } });

    if (stdinFd === null || stdoutFd === null) {
      if (!bridge.killed) bridge.kill('SIGTERM');
      return false;
    }

    this.clientProcess = bridge;
    this.clientStdinFd = stdinFd;
    this.clientStdoutFd = stdoutFd;
    this.clientReadBuffer = Buffer.alloc(0);
    return true;
  }

  private stopClientBridge(): void {
    if (this.clientProcess && !this.clientProcess.killed) {
      this.clientProcess.kill('SIGTERM');
    }
    this.clientProcess = undefined;
    this.clientStdinFd = undefined;
    this.clientStdoutFd = undefined;
    this.clientReadBuffer = Buffer.alloc(0);
  }

  private probeBridgeReady(): void {
    this.startupMetrics.attempts += 1;
    try {
      this.request('health', {}, true);
    } catch {
      this.request('hello', {}, true);
    }
  }

  private probeCommandReady(): void {
    this.startupMetrics.attempts += 1;
    try {
      this.requestViaCommand('health', {});
    } catch {
      this.requestViaCommand('hello', {});
    }
  }

  private markStartupSuccess(strategy: SidecarStartupMetrics['strategy'], startedAt: number): void {
    this.startupMetrics = {
      strategy,
      attempts: this.startupMetrics.attempts,
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }

  private markStartupFailure(startedAt: number, reason: string): void {
    this.startupMetrics = {
      strategy: 'unavailable',
      attempts: this.startupMetrics.attempts,
      durationMs: Math.max(0, Date.now() - startedAt),
      reason,
    };
  }

  private request<T = unknown>(method: string, params?: Record<string, unknown>, ignoreAvailable = false): T {
    if (!ignoreAvailable && (!this.available || !this.binaryPath)) {
      throw new Error('Rust sidecar unavailable');
    }
    if (!this.binaryPath) {
      throw new Error('Rust sidecar binary not configured');
    }

    if (!this.startClientBridge() || this.clientStdinFd === undefined || this.clientStdoutFd === undefined) {
      return this.requestViaCommand(method, params || {});
    }

    const requestId = this.allocateRequestId();
    const payload = `${JSON.stringify({
      id: requestId,
      method,
      params: params || {},
      timeoutMs: this.requestTimeoutMs,
    })}\n`;

    try {
      writeAllSync(this.clientStdinFd, Buffer.from(payload, 'utf8'));
      const line = this.readClientLine();
      let parsed: SidecarRpcResponse<T>;

      try {
        parsed = JSON.parse(line) as SidecarRpcResponse<T>;
      } catch {
        throw new Error(`invalid sidecar response for ${method}: ${normalizeLogText(line) || 'empty response'}`);
      }

      this.assertResponseId(method, requestId, parsed.id);

      if (!parsed.ok) {
        throw new Error(formatSidecarRpcError(method, parsed.error));
      }

      return parsed.result as T;
    } catch (error) {
      this.stopClientBridge();
      throw new Error(`sidecar request failed (${method}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private requestViaCommand<T = unknown>(method: string, params?: Record<string, unknown>): T {
    if (!this.binaryPath) {
      throw new Error('Rust sidecar binary not configured');
    }

    const requestId = this.allocateRequestId();

    const commandArgs = [
      'request',
      '--socket',
      this.socketPath,
      '--id',
      String(requestId),
      '--timeout-ms',
      String(this.requestTimeoutMs),
      '--method',
      method,
      '--params',
      JSON.stringify(params || {}),
    ];

    const result = spawnSync(this.binaryPath, commandArgs, {
      encoding: 'utf8',
      timeout: this.requestTimeoutMs,
    });

    if (result.error || result.status !== 0) {
      const details: string[] = [];
      if (result.error) {
        details.push(`error=${result.error.message}`);
      }
      if (Number.isInteger(result.status)) {
        details.push(`exit=${result.status}`);
      }
      if (result.signal) {
        details.push(`signal=${result.signal}`);
      }

      const stderr = normalizeLogText(result.stderr || '');
      if (stderr) {
        details.push(`stderr=${stderr}`);
      }

      const stdout = normalizeLogText(result.stdout || '');
      if (stdout) {
        details.push(`stdout=${stdout}`);
      }

      throw new Error(`sidecar request failed (${method}): ${details.join(', ') || 'unknown failure'}`);
    }

    let payload: SidecarRpcResponse<T>;
    try {
      payload = JSON.parse((result.stdout || '').trim()) as SidecarRpcResponse<T>;
    } catch {
      throw new Error(`invalid sidecar response for ${method}: ${normalizeLogText(result.stdout || '') || 'empty stdout'}`);
    }

    this.assertResponseId(method, requestId, payload.id);

    if (!payload.ok) {
      throw new Error(formatSidecarRpcError(method, payload.error));
    }

    return payload.result as T;
  }

  private allocateRequestId(): number {
    const current = this.nextRequestId;
    this.nextRequestId += 1;
    if (this.nextRequestId > Number.MAX_SAFE_INTEGER) {
      this.nextRequestId = 1;
    }
    return current;
  }

  private assertResponseId(method: string, requestId: number, responseId: number | undefined): void {
    if (responseId === undefined) {
      return;
    }
    if (!Number.isInteger(responseId) || responseId !== requestId) {
      throw new Error(`sidecar response id mismatch for ${method}: expected=${requestId}, received=${String(responseId)}`);
    }
  }

  private isProcessExited(process: ChildProcess): boolean {
    return process.exitCode !== null || process.signalCode !== null;
  }

  private waitForProcessExit(process: ChildProcess, timeoutMs: number): boolean {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isProcessExited(process)) {
        return true;
      }
      sleepSync(10);
    }
    return this.isProcessExited(process);
  }

  private readClientLine(): string {
    if (this.clientStdoutFd === undefined) {
      throw new Error('client stdout unavailable');
    }

    const deadline = Date.now() + this.requestTimeoutMs;

    for (;;) {
      const newlineIndex = this.clientReadBuffer.indexOf(0x0a);
      if (newlineIndex >= 0) {
        const line = this.clientReadBuffer.subarray(0, newlineIndex).toString('utf8').trim();
        this.clientReadBuffer = this.clientReadBuffer.subarray(newlineIndex + 1);
        return line;
      }

      const chunk = Buffer.allocUnsafe(4096);
      let bytesRead = 0;
      try {
        bytesRead = readSync(this.clientStdoutFd, chunk, 0, chunk.length, null);
      } catch (error) {
        if (isRetryableReadError(error) && Date.now() < deadline) {
          sleepSync(5);
          continue;
        }
        throw error;
      }

      if (bytesRead === 0) {
        throw new Error('sidecar client bridge closed stdout');
      }

      this.clientReadBuffer = Buffer.concat([
        this.clientReadBuffer,
        chunk.subarray(0, bytesRead),
      ]);

      if (this.clientReadBuffer.length > 4 * 1024 * 1024) {
        throw new Error('sidecar client bridge response exceeded 4MiB');
      }

      if (Date.now() >= deadline) {
        throw new Error('timed out waiting for sidecar client bridge response');
      }
    }
  }
}

function isRetryableReadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  return code === 'EAGAIN' || code === 'EWOULDBLOCK';
}

function sleepSync(ms: number): void {
  const lock = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(lock, 0, 0, ms);
}

function getStreamFd(stream: { _handle?: { fd?: number } } | null | undefined): number | null {
  const fd = stream?._handle?.fd;
  if (typeof fd !== 'number' || !Number.isFinite(fd)) {
    return null;
  }
  return fd;
}

function writeAllSync(fd: number, buf: Buffer): void {
  let offset = 0;
  while (offset < buf.length) {
    const written = writeSync(fd, buf, offset, buf.length - offset);
    if (written <= 0) {
      throw new Error('failed to write request payload');
    }
    offset += written;
  }
}

function normalizeLogText(input: string, maxLength: number = 240): string {
  const compact = input.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3)}...`;
}

function formatSidecarRpcError(
  method: string,
  error: string | { code?: string; message?: string } | undefined,
): string {
  if (typeof error === 'string') {
    return error;
  }

  const code = error?.code?.trim();
  const message = error?.message?.trim();
  if (code && message) {
    return `[${code}] ${message}`;
  }
  if (code) {
    return `[${code}] sidecar error for ${method}`;
  }
  if (message) {
    return message;
  }
  return `sidecar error for ${method}`;
}

function resolveSidecarBinaryPath(explicitPath?: string): string | null {
  const candidates = getSidecarBinaryCandidates({
    explicitPath,
    envPath: process.env.DISCODE_PTY_RUST_SIDECAR_BIN,
    cwd: process.cwd(),
    homeDir: homedir(),
    platform: osPlatform(),
    arch: osArch(),
  });

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
  return getDefaultRustSidecarSocketPathForPlatform(process.platform, process.pid, tmpdir());
}

export function getDefaultRustSidecarSocketPathForPlatform(
  platform: NodeJS.Platform,
  pid: number,
  tmpPath: string,
): string {
  if (platform === 'win32') {
    return '\\\\.\\pipe\\discode-pty-rust';
  }
  return join(tmpPath, `discode-pty-rust-${pid}.sock`);
}

type SidecarBinaryCandidateOptions = {
  explicitPath?: string;
  envPath?: string;
  cwd: string;
  homeDir: string;
  platform: NodeJS.Platform;
  arch: string;
};

export function getSidecarBinaryCandidates(options: SidecarBinaryCandidateOptions): string[] {
  const binaryName = options.platform === 'win32' ? 'discode-pty-sidecar.exe' : 'discode-pty-sidecar';
  const osTag = mapPlatformTag(options.platform);
  const archTag = mapArchTag(options.arch);
  const platformTag = osTag && archTag ? `${osTag}-${archTag}` : null;

  return [
    options.explicitPath,
    options.envPath,
    join(options.cwd, 'sidecar', 'pty-rust', 'target', 'release', binaryName),
    platformTag
      ? join(options.cwd, 'dist', 'release', 'sidecar', `discode-pty-sidecar-${platformTag}`, 'bin', binaryName)
      : undefined,
    join(options.homeDir, '.discode', 'bin', binaryName),
    platformTag ? join(options.homeDir, '.discode', 'bin', 'sidecar', platformTag, binaryName) : undefined,
  ].filter(Boolean) as string[];
}

function mapPlatformTag(platform: NodeJS.Platform): 'darwin' | 'linux' | null {
  if (platform === 'darwin' || platform === 'linux') {
    return platform;
  }
  return null;
}

function mapArchTag(arch: string): 'x64' | 'arm64' | null {
  if (arch === 'x64' || arch === 'arm64') {
    return arch;
  }
  return null;
}
