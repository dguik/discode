/**
 * Functional tests for the Codex notify hook script.
 *
 * Tests the actual behavior of discode-codex-notify.js by executing it
 * in a child process with controlled argv and environment variables,
 * then verifying the HTTP POST it makes to the bridge endpoint.
 */

import { existsSync, readFileSync } from 'fs';
import http from 'http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getCodexHookSourcePath } from '../../src/codex/hook-installer.js';

interface CapturedRequest {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

function startCaptureServer(): Promise<{ server: http.Server; port: number; requests: CapturedRequest[] }> {
  return new Promise((resolve) => {
    const requests: CapturedRequest[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        requests.push({
          method: req.method || '',
          url: req.url || '',
          body: JSON.parse(body || '{}'),
        });
        res.writeHead(200);
        res.end('ok');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port, requests });
    });
  });
}

function runHookScript(
  scriptPath: string,
  argv2: string,
  env: Record<string, string>,
): Promise<{ exitCode: number | null }> {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile(
      process.execPath,
      [scriptPath, argv2],
      { env: { ...env, PATH: process.env.PATH }, timeout: 5000 },
      (error: any, _stdout: string, _stderr: string) => {
        resolve({ exitCode: error ? error.code ?? 1 : 0 });
      },
    );
  });
}

describe('codex notify hook script', () => {
  let server: http.Server;
  let port: number;
  let requests: CapturedRequest[];
  const scriptPath = getCodexHookSourcePath();

  beforeAll(async () => {
    const capture = await startCaptureServer();
    server = capture.server;
    port = capture.port;
    requests = capture.requests;
  });

  afterAll(() => {
    server.close();
  });

  afterEach(() => {
    requests.length = 0;
  });

  it('source hook file exists and is readable', () => {
    expect(existsSync(scriptPath)).toBe(true);
    const content = readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('agent-turn-complete');
    expect(content).toContain('process.argv[2]');
  });

  it('posts session.idle to bridge on agent-turn-complete event', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'Here is the fix for the bug.',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
      DISCODE_AGENT: 'codex',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].url).toBe('/opencode-event');
    expect(requests[0].body).toEqual({
      projectName: 'test-project',
      agentType: 'codex',
      type: 'session.idle',
      text: 'Here is the fix for the bug.',
    });
  });

  it('includes instanceId in payload when DISCODE_INSTANCE is set', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'done',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
      DISCODE_INSTANCE: 'codex-2',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.instanceId).toBe('codex-2');
  });

  it('omits instanceId when DISCODE_INSTANCE is not set', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'done',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body).not.toHaveProperty('instanceId');
  });

  it('does not post when event type is not agent-turn-complete', async () => {
    const payload = JSON.stringify({
      type: 'some-other-event',
      'last-assistant-message': 'should not appear',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(0);
  });

  it('does not post when DISCODE_PROJECT is empty', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'should not appear',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: '',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(0);
  });

  it('does not post when DISCODE_PROJECT is not set', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'should not appear',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(0);
  });

  it('handles empty argv gracefully (no JSON argument)', async () => {
    await runHookScript(scriptPath, '', {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    // Empty JSON parses as {}, type won't match, no post
    expect(requests).toHaveLength(0);
  });

  it('handles malformed JSON in argv gracefully', async () => {
    await runHookScript(scriptPath, 'not-valid-json{{{', {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    // Malformed JSON catches and sets input = {}, no match, no post
    expect(requests).toHaveLength(0);
  });

  it('trims whitespace from last-assistant-message', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': '  hello world  \n',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.text).toBe('hello world');
  });

  it('sends empty text when last-assistant-message is missing', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.text).toBe('');
  });

  it('sends empty text when last-assistant-message is not a string', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 12345,
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.text).toBe('');
  });

  it('uses default agent type "codex" when DISCODE_AGENT is not set', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'test',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
      // DISCODE_AGENT not set
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.agentType).toBe('codex');
  });

  // ---------- Legacy env var fallback (AGENT_DISCORD_*) ----------

  it('falls back to AGENT_DISCORD_PROJECT when DISCODE_PROJECT is not set', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'legacy env',
    });

    await runHookScript(scriptPath, payload, {
      AGENT_DISCORD_PROJECT: 'legacy-proj',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.projectName).toBe('legacy-proj');
  });

  it('falls back to AGENT_DISCORD_AGENT when DISCODE_AGENT is not set', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'test',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      AGENT_DISCORD_AGENT: 'legacy-agent',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.agentType).toBe('legacy-agent');
  });

  it('falls back to AGENT_DISCORD_PORT and AGENT_DISCORD_HOSTNAME', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'port test',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      AGENT_DISCORD_PORT: String(port),
      AGENT_DISCORD_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.text).toBe('port test');
  });

  it('DISCODE_* takes precedence over AGENT_DISCORD_*', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'priority',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'new-proj',
      AGENT_DISCORD_PROJECT: 'old-proj',
      DISCODE_AGENT: 'new-agent',
      AGENT_DISCORD_AGENT: 'old-agent',
      DISCODE_PORT: String(port),
      AGENT_DISCORD_PORT: '99999',
      DISCODE_HOSTNAME: '127.0.0.1',
      AGENT_DISCORD_HOSTNAME: '10.0.0.1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.projectName).toBe('new-proj');
    expect(requests[0].body.agentType).toBe('new-agent');
  });

  it('falls back to AGENT_DISCORD_INSTANCE for instanceId', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'inst',
    });

    await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      AGENT_DISCORD_INSTANCE: 'legacy-inst',
      DISCODE_PORT: String(port),
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body.instanceId).toBe('legacy-inst');
  });

  it('works with only AGENT_DISCORD_* env vars (no DISCODE_* set)', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'full legacy',
    });

    await runHookScript(scriptPath, payload, {
      AGENT_DISCORD_PROJECT: 'legacy-proj',
      AGENT_DISCORD_AGENT: 'legacy-agent',
      AGENT_DISCORD_INSTANCE: 'legacy-inst',
      AGENT_DISCORD_PORT: String(port),
      AGENT_DISCORD_HOSTNAME: '127.0.0.1',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].body).toEqual({
      projectName: 'legacy-proj',
      agentType: 'legacy-agent',
      instanceId: 'legacy-inst',
      type: 'session.idle',
      text: 'full legacy',
    });
  });

  // ---------- Error resilience ----------

  it('silently handles bridge connection failure (no crash)', async () => {
    const payload = JSON.stringify({
      type: 'agent-turn-complete',
      'last-assistant-message': 'test',
    });

    // Use a port that's not listening
    const result = await runHookScript(scriptPath, payload, {
      DISCODE_PROJECT: 'test-project',
      DISCODE_PORT: '1', // unlikely to have a server
      DISCODE_HOSTNAME: '127.0.0.1',
    });

    // Should not crash — exits gracefully
    expect(result.exitCode).toBe(0);
    expect(requests).toHaveLength(0);
  });
});
