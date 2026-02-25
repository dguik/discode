/**
 * Shared test infrastructure for Codex hook script functional tests.
 *
 * Provides HTTP capture server, hook script runner, and payload factories
 * used across the split test files.
 */

import http from 'http';

export interface CapturedRequest {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

export function startCaptureServer(): Promise<{ server: http.Server; port: number; requests: CapturedRequest[] }> {
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

export function runHookScript(
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

/** Helper to create an OpenAI-format input-messages array for a single tool call turn. */
export function makeToolTurnPayload(opts: {
  toolName: string;
  toolArgs: Record<string, unknown> | string;
  toolResult?: string;
  finalMessage?: string;
  userMessage?: string;
}): string {
  const argsStr = typeof opts.toolArgs === 'string'
    ? opts.toolArgs
    : JSON.stringify(opts.toolArgs);
  return JSON.stringify({
    type: 'agent-turn-complete',
    'last-assistant-message': opts.finalMessage ?? 'Done.',
    'input-messages': [
      { role: 'user', content: opts.userMessage ?? 'Do the task' },
      {
        role: 'assistant',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: opts.toolName, arguments: argsStr },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: opts.toolResult ?? '' },
      { role: 'assistant', content: opts.finalMessage ?? 'Done.' },
    ],
  });
}

export function defaultEnv(port: number) {
  return {
    DISCODE_PROJECT: 'test-project',
    DISCODE_PORT: String(port),
    DISCODE_HOSTNAME: '127.0.0.1',
    DISCODE_AGENT: 'codex',
  };
}
