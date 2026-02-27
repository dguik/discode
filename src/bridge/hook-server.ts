/**
 * HTTP server + route dispatch.
 * Delegates to HookRuntimeRoutes and HookEventPipeline for actual handling.
 */

import { createServer, type IncomingMessage } from 'http';
import { parse } from 'url';
import type { MessagingClient } from '../messaging/interface.js';
import type { IStateManager } from '../types/interfaces.js';
import type { AgentRuntime } from '../runtime/interface.js';
import { PendingMessageTracker } from './pending-message-tracker.js';
import type { StreamingMessageUpdater } from './streaming-message-updater.js';
import { HookRuntimeRoutes } from './hook-runtime-routes.js';
import { HookEventPipeline } from './hook-event-pipeline.js';

export interface BridgeHookServerDeps {
  port: number;
  messaging: MessagingClient;
  stateManager: IStateManager;
  pendingTracker: PendingMessageTracker;
  streamingUpdater: StreamingMessageUpdater;
  reloadChannelMappings: () => void;
  runtime?: AgentRuntime;
  /** Bearer token for authenticating hook requests. If set, all requests (except /health) must include it. */
  authToken?: string;
}

type StatusResult = { status: number; message: string };
type HttpRes = { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body: string) => void };

export class BridgeHookServer {
  private httpServer?: ReturnType<typeof createServer>;
  private runtimeRoutes: HookRuntimeRoutes;
  private eventPipeline: HookEventPipeline;

  private static readonly MAX_BODY_BYTES = 256 * 1024;

  // Token bucket rate limiter: 60 tokens, refill 60/sec (1 req/sec sustained, burst up to 60)
  private rateLimitTokens = 60;
  private rateLimitMax = 60;
  private rateLimitRefillRate = 60; // tokens per second
  private rateLimitLastRefill = Date.now();

  private readyResolve?: () => void;
  private readyPromise: Promise<void>;

  private statusRoutes: Record<string, (payload: unknown) => StatusResult | Promise<StatusResult>>;

  constructor(private deps: BridgeHookServerDeps) {
    this.readyPromise = new Promise<void>((resolve) => { this.readyResolve = resolve; });
    this.runtimeRoutes = new HookRuntimeRoutes({
      port: deps.port,
      messaging: deps.messaging,
      stateManager: deps.stateManager,
      runtime: deps.runtime,
    });
    this.eventPipeline = new HookEventPipeline({
      messaging: deps.messaging,
      stateManager: deps.stateManager,
      pendingTracker: deps.pendingTracker,
      streamingUpdater: deps.streamingUpdater,
    });

    this.statusRoutes = {
      '/runtime/focus': (p) => this.runtimeRoutes.handleRuntimeFocus(p),
      '/runtime/input': (p) => this.runtimeRoutes.handleRuntimeInput(p),
      '/runtime/stop': (p) => this.runtimeRoutes.handleRuntimeStop(p),
      '/runtime/ensure': (p) => this.runtimeRoutes.handleRuntimeEnsure(p),
      '/send-files': (p) => this.runtimeRoutes.handleSendFiles(p),
    };
  }

  start(): void {
    this.httpServer = createServer(async (req, res) => {
      const parsed = parse(req.url || '', true);
      const pathname = parsed.pathname;

      // /health is exempt from authentication
      if (req.method === 'GET' && pathname === '/health') {
        res.writeHead(200);
        res.end('OK');
        return;
      }

      if (!this.checkAuth(req, res)) return;
      if (!this.checkRateLimit(res)) return;

      if (req.method === 'GET' && pathname === '/runtime/windows') {
        this.runtimeRoutes.handleRuntimeWindows(res);
        return;
      }

      if (req.method === 'GET' && pathname === '/runtime/buffer') {
        const windowId = this.readQueryString(parsed.query.windowId);
        const sinceRaw = this.readQueryString(parsed.query.since);
        const since = sinceRaw ? parseInt(sinceRaw, 10) : 0;
        this.runtimeRoutes.handleRuntimeBuffer(res, windowId, Number.isFinite(since) ? since : 0);
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
      }

      let body = '';
      let aborted = false;
      req.on('data', (chunk) => {
        if (aborted) return;
        body += chunk.toString('utf8');
        if (body.length > BridgeHookServer.MAX_BODY_BYTES) {
          aborted = true;
          res.writeHead(413);
          res.end('Payload too large');
          req.destroy();
        }
      });
      req.on('end', () => {
        if (aborted) return;
        void (async () => {
          try {
            await this.dispatchPostRoute(pathname || '', body, res);
          } catch (error) {
            console.error('Request processing error:', error);
            res.writeHead(500);
            res.end('Internal error');
          }
        })();
      });
    });

    this.httpServer.on('error', (err) => {
      console.error('HTTP server error:', err);
    });

    this.httpServer.listen(this.deps.port, '127.0.0.1', () => {
      this.readyResolve?.();
    });
  }

  /** Resolves when the HTTP server is listening. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /** Returns the bound address (useful when started with port 0). */
  address(): { port: number } | null {
    const addr = this.httpServer?.address();
    if (addr && typeof addr === 'object') return { port: addr.port };
    return null;
  }

  /** Update the auth token (e.g. after generation at startup). */
  setAuthToken(token: string): void {
    this.deps.authToken = token;
  }

  stop(): void {
    this.eventPipeline.stop();
    this.httpServer?.close();
    this.httpServer = undefined;
  }

  // Public so AgentBridge can call it for SDK runner events
  async handleOpencodeEvent(payload: unknown): Promise<boolean> {
    return this.eventPipeline.handleOpencodeEvent(payload);
  }

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  private checkRateLimit(res: HttpRes): boolean {
    const now = Date.now();
    const elapsed = (now - this.rateLimitLastRefill) / 1000;
    this.rateLimitTokens = Math.min(this.rateLimitMax, this.rateLimitTokens + elapsed * this.rateLimitRefillRate);
    this.rateLimitLastRefill = now;

    if (this.rateLimitTokens < 1) {
      res.writeHead(429);
      res.end('Too many requests');
      return false;
    }

    this.rateLimitTokens -= 1;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Auth helpers
  // ---------------------------------------------------------------------------

  private checkAuth(req: IncomingMessage, res: HttpRes): boolean {
    const token = this.deps.authToken;
    if (!token) return true;

    const authHeader = req.headers['authorization'];
    if (authHeader === `Bearer ${token}`) return true;

    res.writeHead(401);
    res.end('Unauthorized');
    return false;
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  private readQueryString(value: string | string[] | undefined): string | undefined {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length > 0) return value[0];
    return undefined;
  }

  private parseJsonBody(body: string, res: HttpRes): unknown | null {
    try {
      return body ? JSON.parse(body) : {};
    } catch {
      res.writeHead(400);
      res.end('Invalid JSON');
      return null;
    }
  }

  private async dispatchPostRoute(pathname: string, body: string, res: HttpRes): Promise<void> {
    if (pathname === '/reload') {
      this.deps.reloadChannelMappings();
      res.writeHead(200);
      res.end('OK');
      return;
    }

    const payload = this.parseJsonBody(body, res);
    if (payload === null) return;

    const statusHandler = this.statusRoutes[pathname];
    if (statusHandler) {
      const result = await statusHandler(payload);
      res.writeHead(result.status);
      res.end(result.message);
      return;
    }

    if (pathname === '/opencode-event') {
      const ok = await this.handleOpencodeEvent(payload);
      if (ok) {
        res.writeHead(200);
        res.end('OK');
      } else {
        res.writeHead(400);
        res.end('Invalid event payload');
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }
}
