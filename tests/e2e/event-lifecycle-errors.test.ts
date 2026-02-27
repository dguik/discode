/**
 * E2E tests for HTTP-level error handling of BridgeHookServer.
 *
 * Tests authentication, rate limiting, malformed payloads, and pipeline
 * resilience using a real HTTP server bound to a random port.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import {
  startFullHookServer,
  postEvent,
  postRaw,
  getRequest,
  TEST_AUTH_TOKEN,
} from './e2e-helpers.js';
import { postJSON } from '../bridge/hook-server-helpers.js';
import type { FullHookServerResult } from './e2e-helpers.js';

// ---------------------------------------------------------------------------
// Baseline valid event payload — gets past all pipeline validation
// ---------------------------------------------------------------------------

const VALID_EVENT = {
  projectName: 'test-proj',
  type: 'session.idle',
  agentType: 'claude',
} as const;

// ---------------------------------------------------------------------------
// Helper: send an HTTP request with an arbitrary method using node http module
// ---------------------------------------------------------------------------

function rawRequest(
  port: number,
  method: string,
  path: string,
  token?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    const t = token ?? TEST_AUTH_TOKEN;
    if (t) headers['Authorization'] = `Bearer ${t}`;
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Event Lifecycle Error Flows', () => {
  let ctx: FullHookServerResult;

  beforeEach(async () => {
    ctx = await startFullHookServer({});
  });

  afterEach(() => {
    ctx.server.stop();
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  describe('Authentication', () => {
    it('returns 401 when no auth token is provided', async () => {
      // Pass an empty string so postJSON sends no Authorization header value.
      // The server compares authHeader === `Bearer ${token}`, empty string fails.
      const res = await postJSON(ctx.port, '/opencode-event', VALID_EVENT, '');
      expect(res.status).toBe(401);
    });

    it('returns 401 with an incorrect token', async () => {
      const res = await postJSON(ctx.port, '/opencode-event', VALID_EVENT, 'wrong-token');
      expect(res.status).toBe(401);
    });

    it('returns 200 with the correct Bearer token', async () => {
      const res = await postJSON(ctx.port, '/opencode-event', VALID_EVENT, TEST_AUTH_TOKEN);
      expect(res.status).toBe(200);
    });

    it('allows GET /health without an auth token', async () => {
      // getRequest defaults to TEST_AUTH_TOKEN — pass empty string to strip it
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port: ctx.port, path: '/health', method: 'GET' },
          (httpRes) => {
            let data = '';
            httpRes.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            httpRes.on('end', () => resolve({ status: httpRes.statusCode ?? 0, body: data }));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  describe('Rate limiting', () => {
    it('allows a burst of up to 60 requests', async () => {
      // The token bucket starts at 60. All 60 concurrent requests should succeed.
      const requests = Array.from({ length: 60 }, () =>
        postEvent(ctx.port, VALID_EVENT),
      );
      const results = await Promise.all(requests);
      const statuses = results.map((r) => r.status);
      expect(statuses.every((s) => s === 200)).toBe(true);
    });

    it('returns 429 when the token bucket is exhausted', async () => {
      // Drain tokens with rapid sequential requests until we get a 429.
      // The bucket starts at 60, refills at 60/sec. Sending sequentially
      // is fast enough that we'll exhaust the bucket within ~70 requests
      // even with some refill during the loop.
      let got429 = false;
      for (let i = 0; i < 80; i++) {
        const res = await postEvent(ctx.port, VALID_EVENT);
        if (res.status === 429) {
          got429 = true;
          break;
        }
      }
      expect(got429).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Malformed payloads
  // -------------------------------------------------------------------------

  describe('Malformed payloads', () => {
    it('returns 400 for a non-JSON body', async () => {
      const res = await postRaw(ctx.port, '/opencode-event', 'not json{');
      expect(res.status).toBe(400);
    });

    it('returns 400 when projectName is missing from the event', async () => {
      const res = await postEvent(ctx.port, {
        type: 'session.idle',
        agentType: 'claude',
        // projectName intentionally omitted
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when projectName does not match any registered project', async () => {
      const res = await postEvent(ctx.port, {
        projectName: 'does-not-exist',
        type: 'session.idle',
        agentType: 'claude',
      });
      expect(res.status).toBe(400);
    });

    it('returns 413 when the payload exceeds 256 KB', async () => {
      // MAX_BODY_BYTES = 256 * 1024 = 262144.
      // The JSON envelope adds ~37 bytes, so we need the text field to push the
      // total raw body length past 262144.  Use 263000 'x' chars to be safe.
      const oversize = JSON.stringify({ projectName: 'test-proj', text: 'x'.repeat(263_000) });
      const res = await postRaw(ctx.port, '/opencode-event', oversize);
      expect(res.status).toBe(413);
    });

    it('returns 404 for an unknown POST route', async () => {
      const res = await postJSON(ctx.port, '/unknown-route', VALID_EVENT);
      expect(res.status).toBe(404);
    });

    it('returns 405 for non-POST/GET methods (DELETE)', async () => {
      const res = await rawRequest(ctx.port, 'DELETE', '/opencode-event');
      expect(res.status).toBe(405);
    });
  });

  // -------------------------------------------------------------------------
  // Pipeline resilience
  // -------------------------------------------------------------------------

  describe('Pipeline resilience', () => {
    it('does not crash the server when a messaging call throws during event handling', async () => {
      // Make sendToChannel reject to simulate a downstream messaging failure.
      // handleSessionError calls sendToChannel — if it throws, enqueueForChannel's
      // .catch() absorbs the error and the server still responds with 200.
      const sendToChannel = ctx.messaging.sendToChannel as ReturnType<typeof vi.fn>;
      sendToChannel.mockRejectedValueOnce(new Error('simulated Slack failure'));

      const res = await postEvent(ctx.port, {
        projectName: 'test-proj',
        type: 'session.error',
        agentType: 'claude',
        text: 'something went wrong',
      });

      // The HTTP layer must respond successfully even though the handler threw.
      expect(res.status).toBe(200);

      // Confirm the server is still operational by sending a second request.
      const followUp = await postEvent(ctx.port, VALID_EVENT);
      expect(followUp.status).toBe(200);
    });
  });
});
