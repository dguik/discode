#!/usr/bin/env node

import { spawn, spawnSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import readline from 'readline';

function parseArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) {
    return fallback;
  }
  return process.argv[index + 1];
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.max(0, Math.min(sorted.length - 1, rank));
  return sorted[index];
}

function summarize(valuesMs) {
  const sorted = [...valuesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.length > 0 ? sum / sorted.length : 0,
  };
}

function formatMs(value) {
  return `${value.toFixed(3)}ms`;
}

function measureSync(fn) {
  const start = process.hrtime.bigint();
  fn();
  const end = process.hrtime.bigint();
  return Number(end - start) / 1_000_000;
}

async function measureAsync(fn) {
  const start = process.hrtime.bigint();
  await fn();
  const end = process.hrtime.bigint();
  return Number(end - start) / 1_000_000;
}

function resolveBinaryPath(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.DISCODE_PTY_RUST_SIDECAR_BIN,
    join(process.cwd(), 'sidecar', 'pty-rust', 'target', 'release', 'discode-pty-sidecar'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function requestOnce(binaryPath, socketPath, method, params) {
  const result = spawnSync(
    binaryPath,
    [
      'request',
      '--socket',
      socketPath,
      '--method',
      method,
      '--timeout-ms',
      '2000',
      '--params',
      JSON.stringify(params),
    ],
    {
      encoding: 'utf8',
      timeout: 2000,
    },
  );

  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || `request failed (${String(result.status)})`);
  }

  const parsed = JSON.parse((result.stdout || '').trim());
  if (!parsed?.ok) {
    throw new Error(`sidecar returned error for method '${method}'`);
  }
  return parsed.result;
}

class PersistentBridgeClient {
  constructor(binaryPath, socketPath) {
    this.nextId = 1;
    this.pending = [];
    this.process = spawn(binaryPath, ['client', '--socket', socketPath], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    this.rl = readline.createInterface({ input: this.process.stdout });
    this.rl.on('line', (line) => {
      const pending = this.pending.shift();
      if (!pending) return;
      pending.resolve(line);
    });
  }

  async request(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params, timeoutMs: 2000 });
    const line = await this.enqueueLine(payload);
    const parsed = JSON.parse(line);
    if (!parsed?.ok) {
      throw new Error(`bridge request failed for method '${method}'`);
    }
    return parsed.result;
  }

  enqueueLine(payload) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('bridge response timeout'));
      }, 2000);

      this.pending.push({
        resolve: (line) => {
          clearTimeout(timeout);
          resolve(line);
        },
      });

      this.process.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.pop();
        reject(error);
      });
    });
  }

  close() {
    this.rl.close();
    if (!this.process.killed) {
      this.process.kill('SIGTERM');
    }
  }
}

async function waitForServer(binaryPath, socketPath) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      requestOnce(binaryPath, socketPath, 'health', {});
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('sidecar server did not become ready within 5s');
}

function startServer(binaryPath, socketPath) {
  return spawn(binaryPath, ['server', '--socket', socketPath], { stdio: 'ignore' });
}

function stopServer(binaryPath, socketPath, server) {
  try {
    requestOnce(binaryPath, socketPath, 'dispose', {});
  } catch {
    // best effort
  }

  if (!server.killed) {
    server.kill('SIGTERM');
  }

  try {
    rmSync(socketPath, { force: true });
  } catch {
    // best effort
  }
}

async function benchmarkRequestMode(binaryPath, socketPath, warmup, iterations) {
  const server = startServer(binaryPath, socketPath);
  try {
    await waitForServer(binaryPath, socketPath);
    for (let i = 0; i < warmup; i += 1) {
      requestOnce(binaryPath, socketPath, 'health', {});
    }

    const samples = [];
    for (let i = 0; i < iterations; i += 1) {
      samples.push(measureSync(() => requestOnce(binaryPath, socketPath, 'health', {})));
    }
    return samples;
  } finally {
    stopServer(binaryPath, socketPath, server);
  }
}

async function benchmarkBridgeMode(binaryPath, socketPath, warmup, iterations) {
  const server = startServer(binaryPath, socketPath);
  let bridge;
  try {
    await waitForServer(binaryPath, socketPath);
    bridge = new PersistentBridgeClient(binaryPath, socketPath);
    await bridge.request('health', {});

    for (let i = 0; i < warmup; i += 1) {
      await bridge.request('health', {});
    }

    const samples = [];
    for (let i = 0; i < iterations; i += 1) {
      samples.push(await measureAsync(() => bridge.request('health', {})));
    }
    return samples;
  } finally {
    if (bridge) {
      try {
        bridge.close();
      } catch {
        // best effort
      }
    }
    stopServer(binaryPath, socketPath, server);
  }
}

async function main() {
  const iterations = Number(parseArg('--iterations', '200'));
  const warmup = Number(parseArg('--warmup', '20'));
  const binaryPath = resolveBinaryPath(parseArg('--binary', ''));

  if (!binaryPath) {
    throw new Error('sidecar binary not found. Run `npm run sidecar:build` or set DISCODE_PTY_RUST_SIDECAR_BIN');
  }

  const socketBase = parseArg(
    '--socket',
    join('/tmp', `discode-pty-rust-bench-${process.pid}-${Date.now()}`),
  );
  const requestSocketPath = `${socketBase}-request.sock`;
  const bridgeSocketPath = `${socketBase}-bridge.sock`;

  const requestMode = await benchmarkRequestMode(binaryPath, requestSocketPath, warmup, iterations);
  const bridgeMode = await benchmarkBridgeMode(binaryPath, bridgeSocketPath, warmup, iterations);

  const requestSummary = summarize(requestMode);
  const bridgeSummary = summarize(bridgeMode);
  const p95DeltaMs = requestSummary.p95 - bridgeSummary.p95;
  const p95ImprovementPercent = requestSummary.p95 > 0
    ? (p95DeltaMs / requestSummary.p95) * 100
    : 0;

  const report = {
    iterations,
    warmup,
    binaryPath,
    requestSocketPath,
    bridgeSocketPath,
    baselineRequestMode: requestSummary,
    persistentBridgeMode: bridgeSummary,
    p95DeltaMs,
    p95ImprovementPercent,
    pass: p95DeltaMs > 0,
  };

  console.log('Sidecar latency benchmark (health RPC)');
  console.log(`- request-per-process p95: ${formatMs(requestSummary.p95)}`);
  console.log(`- persistent-bridge p95:  ${formatMs(bridgeSummary.p95)}`);
  console.log(`- p95 delta:               ${formatMs(p95DeltaMs)} (${p95ImprovementPercent.toFixed(1)}%)`);
  console.log(`- gate (bridge p95 < request p95): ${report.pass ? 'PASS' : 'FAIL'}`);
  console.log('');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(`benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
