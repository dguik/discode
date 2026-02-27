import { createServer, type Server } from 'net';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { AgentRuntime } from './interface.js';
import { incRuntimeMetric } from './vt-diagnostics.js';
import {
  clampNumber,
  decodeBase64,
  type RuntimeStreamClientState,
} from './stream-utilities.js';
import { flushClientFrame, type FrameRendererOptions } from './stream-frame-renderer.js';
import { createRuntimeWindowApi, type RuntimeWindowApi } from './window-api.js';
import { parseRuntimeWindowId } from './window-id.js';
import { RUNTIME_STREAM_PROTOCOL_VERSION } from './protocol.js';

function parseProtocolVersion(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

type RuntimeStreamServerOptions = {
  tickMs?: number;
  minEmitIntervalMs?: number;
  enablePatchDiff?: boolean;
  patchThresholdRatio?: number;
};

type RuntimeStreamInbound =
  | { type: 'hello'; clientId?: string; version?: number | string }
  | { type: 'subscribe'; windowId: string; cols?: number; rows?: number }
  | { type: 'focus'; windowId: string }
  | { type: 'input'; windowId: string; bytesBase64: string }
  | { type: 'resize'; windowId: string; cols: number; rows: number };

export class RuntimeStreamServer {
  private server?: Server;
  private clients = new Set<RuntimeStreamClientState>();
  private pollTimer?: NodeJS.Timeout;
  private runtime: AgentRuntime;
  private runtimeApi: RuntimeWindowApi;
  private tickMs: number;
  private frameOptions: FrameRendererOptions;

  constructor(
    runtime: AgentRuntime,
    private socketPath: string = getDefaultRuntimeSocketPath(),
    options?: RuntimeStreamServerOptions,
  ) {
    this.runtime = runtime;
    this.runtimeApi = createRuntimeWindowApi(runtime);
    this.tickMs = clampNumber(options?.tickMs, 16, 200, 33);
    this.frameOptions = {
      minEmitIntervalMs: clampNumber(options?.minEmitIntervalMs, 16, 250, 50),
      enablePatchDiff: options?.enablePatchDiff ?? process.env.DISCODE_STREAM_PATCH_DIFF === '1',
      patchThresholdRatio: Math.max(0.05, Math.min(0.95, options?.patchThresholdRatio ?? 0.55)),
    };
  }

  start(): void {
    this.cleanupSocketPath();

    this.server = createServer((socket) => {
      const state: RuntimeStreamClientState = {
        socket,
        buffer: '',
        cols: 120,
        rows: 40,
        seq: 0,
        lastBufferLength: -1,
        lastSnapshot: '',
        lastLines: [],
        lastEmitAt: 0,
        windowMissingNotified: false,
        runtimeErrorNotified: false,
        lastStyledSignature: '',
        lastStyledLines: [],
        lastCursorRow: -1,
        lastCursorCol: -1,
        lastCursorVisible: true,
      };
      this.clients.add(state);

      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        state.buffer += chunk;
        let idx = state.buffer.indexOf('\n');
        while (idx >= 0) {
          const line = state.buffer.slice(0, idx).trim();
          state.buffer = state.buffer.slice(idx + 1);
          if (line.length > 0) {
            this.handleMessage(state, line);
          }
          idx = state.buffer.indexOf('\n');
        }
      });

      socket.on('close', () => {
        this.clients.delete(state);
      });

      socket.on('error', () => {
        this.clients.delete(state);
      });
    });

    this.server.on('error', (err: Error) => {
      console.error(`[stream-server] listen error: ${err.message}`);
    });
    this.server.listen(this.socketPath, () => {
      console.log(`[stream-server] listening on ${this.socketPath}`);
    });
    this.pollTimer = setInterval(() => this.flushFrames(), this.tickMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    for (const client of this.clients) {
      client.socket.destroy();
    }
    this.clients.clear();

    // Only clean up the socket file if this server actually started listening.
    // Other AgentBridge instances (e.g. from `discode new`) create a
    // RuntimeStreamServer but never call start(); cleaning up the socket
    // in that case would delete the daemon's active socket file.
    if (this.server) {
      this.server.close();
      this.server = undefined;
      this.cleanupSocketPath();
    }
  }

  private handleMessage(client: RuntimeStreamClientState, line: string): void {
    let message: RuntimeStreamInbound;
    try {
      message = JSON.parse(line) as RuntimeStreamInbound;
    } catch {
      this.send(client, { type: 'error', code: 'bad_json', message: 'Invalid JSON' });
      return;
    }

    if (!message || typeof message !== 'object' || !('type' in message)) {
      this.send(client, { type: 'error', code: 'bad_message', message: 'Invalid message' });
      return;
    }

    switch (message.type) {
      case 'hello': {
        const requestedVersion = parseProtocolVersion(message.version);
        if (requestedVersion !== undefined && requestedVersion !== RUNTIME_STREAM_PROTOCOL_VERSION) {
          this.send(client, {
            type: 'error',
            code: 'unsupported_protocol_version',
            message: `Unsupported runtime stream protocol version: ${requestedVersion}`,
            streamProtocolVersion: RUNTIME_STREAM_PROTOCOL_VERSION,
          });
          client.socket.destroy();
          return;
        }
        this.send(client, {
          type: 'hello',
          ok: true,
          streamProtocolVersion: RUNTIME_STREAM_PROTOCOL_VERSION,
        });
        return;
      }
      case 'subscribe': {
        if (!message.windowId || typeof message.windowId !== 'string') {
          this.send(client, { type: 'error', code: 'bad_subscribe', message: 'Missing windowId' });
          return;
        }
        client.windowId = message.windowId;
        client.cols = clampNumber(message.cols, 30, 240, 120);
        client.rows = clampNumber(message.rows, 10, 120, 40);
        this.resetClientState(client);
        flushClientFrame(client, this.runtime, this.frameOptions, this.send.bind(this), true);
        return;
      }
      case 'focus': {
        if (!message.windowId || typeof message.windowId !== 'string') {
          this.send(client, { type: 'error', code: 'bad_focus', message: 'Missing windowId' });
          return;
        }
        client.windowId = message.windowId;
        this.resetClientState(client);
        this.send(client, { type: 'focus', ok: true, windowId: message.windowId });
        flushClientFrame(client, this.runtime, this.frameOptions, this.send.bind(this), true);
        return;
      }
      case 'input': {
        const parsed = parseRuntimeWindowId(message.windowId);
        if (!parsed) {
          this.send(client, { type: 'error', code: 'bad_input', message: 'Invalid windowId' });
          return;
        }
        const bytes = decodeBase64(message.bytesBase64);
        if (!bytes) {
          this.send(client, { type: 'error', code: 'bad_input', message: 'Invalid bytesBase64' });
          return;
        }
        if (!this.runtimeApi.exists(parsed)) {
          this.send(client, {
            type: 'window-exit',
            windowId: message.windowId,
            code: null,
            signal: 'missing',
          });
          return;
        }
        try {
          this.runtimeApi.input(parsed, bytes.toString('utf8'));
        } catch (error) {
          this.send(client, {
            type: 'window-exit',
            windowId: message.windowId,
            code: null,
            signal: 'not_running',
          });
          incRuntimeMetric('stream_runtime_error');
          return;
        }
        this.send(client, { type: 'input', ok: true, windowId: message.windowId });
        return;
      }
      case 'resize': {
        if (!message.windowId || typeof message.windowId !== 'string') return;
        client.windowId = message.windowId;
        client.cols = clampNumber(message.cols, 30, 240, client.cols);
        client.rows = clampNumber(message.rows, 10, 120, client.rows);
        const parsed = parseRuntimeWindowId(message.windowId);
        if (parsed) {
          try {
            this.runtimeApi.resize(parsed, client.cols, client.rows);
          } catch {
            // best effort; client-side view still updates with requested size
          }
        }
        this.resetClientState(client);
        flushClientFrame(client, this.runtime, this.frameOptions, this.send.bind(this), true);
        return;
      }
      default:
        this.send(client, { type: 'error', code: 'unknown_type', message: 'Unknown message type' });
    }
  }

  private flushFrames(): void {
    const sendBound = this.send.bind(this);
    for (const client of this.clients) {
      flushClientFrame(client, this.runtime, this.frameOptions, sendBound, false);
    }
  }

  private resetClientState(client: RuntimeStreamClientState): void {
    client.lastBufferLength = -1;
    client.lastSnapshot = '';
    client.lastLines = [];
    client.windowMissingNotified = false;
    client.runtimeErrorNotified = false;
    client.lastStyledSignature = '';
    client.lastStyledLines = [];
    client.lastCursorRow = -1;
    client.lastCursorCol = -1;
    client.lastCursorVisible = true;
  }

  private send(client: RuntimeStreamClientState, payload: unknown): void {
    try {
      const withVersion = payload && typeof payload === 'object'
        ? {
          ...(payload as Record<string, unknown>),
          streamProtocolVersion: RUNTIME_STREAM_PROTOCOL_VERSION,
        }
        : payload;
      client.socket.write(`${JSON.stringify(withVersion)}\n`);
    } catch {
      this.clients.delete(client);
    }
  }

  private cleanupSocketPath(): void {
    if (process.platform === 'win32') return;
    try {
      if (existsSync(this.socketPath)) {
        unlinkSync(this.socketPath);
      }
      const dir = dirname(this.socketPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    } catch {
      // best-effort cleanup
    }
  }
}

export function getDefaultRuntimeSocketPath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\discode-runtime';
  }
  return join(homedir(), '.discode', 'runtime.sock');
}
