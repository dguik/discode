/**
 * E2E tests for daemon lifecycle orchestration.
 *
 * Unlike the unit tests in tests/app/daemon-service.test.ts (which test each
 * function in isolation), these tests chain daemon-service calls together to
 * verify that the full orchestration flows work correctly end-to-end:
 *
 *   ensureDaemonRunning → getDaemonStatus → stopDaemon → restartDaemonIfRunning
 *
 * The DaemonManager is replaced with a lightweight mock so that no real
 * sockets, processes, or file-system side-effects occur.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────
//
// Declared before any imports so that vi.mock hoisting picks them up.
// Each mock fn has a stable default so individual tests only need to
// override the specific call that differs from the baseline.

const mockIsRunning = vi.fn().mockResolvedValue(false);
const mockGetPort = vi.fn().mockReturnValue(18470);
const mockGetLogFile = vi.fn().mockReturnValue('/home/user/.discode/daemon.log');
const mockGetPidFile = vi.fn().mockReturnValue('/home/user/.discode/daemon.pid');
const mockStartDaemon = vi.fn().mockReturnValue(12345);
const mockStopDaemon = vi.fn().mockReturnValue(true);
const mockWaitForReady = vi.fn().mockResolvedValue(true);

vi.mock('../../src/daemon.js', () => ({
  defaultDaemonManager: {
    isRunning: (...args: any[]) => mockIsRunning(...args),
    getPort: (...args: any[]) => mockGetPort(...args),
    getLogFile: (...args: any[]) => mockGetLogFile(...args),
    getPidFile: (...args: any[]) => mockGetPidFile(...args),
    startDaemon: (...args: any[]) => mockStartDaemon(...args),
    stopDaemon: (...args: any[]) => mockStopDaemon(...args),
    waitForReady: (...args: any[]) => mockWaitForReady(...args),
  },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
  };
});

// ── Import after mocks ──────────────────────────────────────────────
//
// Imports must come after vi.mock() calls so that the hoisted mocks are
// in place before daemon-service resolves its own imports.

import {
  ensureDaemonRunning,
  getDaemonStatus,
  stopDaemon,
  restartDaemonIfRunning,
} from '../../src/app/daemon-service.js';

// ── Tests ────────────────────────────────────────────────────────────

describe('Daemon Lifecycle E2E', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────
  // Full start → status → stop cycle
  // ──────────────────────────────────────────────────────────────────

  describe('Full start → status → stop cycle', () => {
    it('ensureDaemonRunning starts daemon, getDaemonStatus confirms running, stopDaemon shuts down', async () => {
      // Phase 1: daemon is not running — ensureDaemonRunning should spawn it.
      // ensureDaemonRunning calls isRunning() once; the default mock returns false.
      mockIsRunning.mockResolvedValueOnce(false);

      const startResult = await ensureDaemonRunning();

      expect(startResult.alreadyRunning).toBe(false);
      expect(startResult.ready).toBe(true);
      expect(startResult.port).toBe(18470);
      expect(startResult.logFile).toBe('/home/user/.discode/daemon.log');
      expect(mockStartDaemon).toHaveBeenCalledOnce();
      expect(mockWaitForReady).toHaveBeenCalledOnce();

      // Phase 2: daemon is now up — getDaemonStatus should report running.
      mockIsRunning.mockResolvedValueOnce(true);

      const status = await getDaemonStatus();

      expect(status.running).toBe(true);
      expect(status.port).toBe(18470);
      expect(status.logFile).toBe('/home/user/.discode/daemon.log');
      expect(status.pidFile).toBe('/home/user/.discode/daemon.pid');

      // Phase 3: request a stop — stopDaemon should delegate to the manager.
      mockStopDaemon.mockReturnValueOnce(true);

      const stopped = stopDaemon();

      expect(stopped).toBe(true);
      expect(mockStopDaemon).toHaveBeenCalledOnce();

      // Phase 4: after stopping, getDaemonStatus should report not running.
      mockIsRunning.mockResolvedValueOnce(false);

      const statusAfterStop = await getDaemonStatus();

      expect(statusAfterStop.running).toBe(false);
    });

    it('ensureDaemonRunning detects already running daemon and skips spawn', async () => {
      // isRunning returns true — the early-return path should be taken.
      mockIsRunning.mockResolvedValueOnce(true);

      const result = await ensureDaemonRunning();

      expect(result.alreadyRunning).toBe(true);
      expect(result.ready).toBe(true);
      expect(result.port).toBe(18470);
      expect(result.logFile).toBe('/home/user/.discode/daemon.log');
      expect(mockStartDaemon).not.toHaveBeenCalled();
      expect(mockWaitForReady).not.toHaveBeenCalled();
    });

    it('getDaemonStatus returns not-running when daemon is down after a stop', async () => {
      // Simulate: was running, then stopped, then status checked.
      mockStopDaemon.mockReturnValueOnce(true);
      stopDaemon();

      mockIsRunning.mockResolvedValueOnce(false);
      const status = await getDaemonStatus();

      expect(status.running).toBe(false);
      expect(status.port).toBe(18470);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Restart cycle
  // ──────────────────────────────────────────────────────────────────

  describe('Restart cycle', () => {
    it('restartDaemonIfRunning stops then starts the daemon', async () => {
      // restartDaemonIfRunning flow:
      //   1. getDaemonStatus()     → isRunning() call #1  (true  → proceed)
      //   2. stopDaemon()          → manager.stopDaemon() (true  → proceed)
      //   3. ensureDaemonRunning() → isRunning() call #2  (false → spawn)
      mockIsRunning.mockResolvedValueOnce(true);  // getDaemonStatus
      mockStopDaemon.mockReturnValueOnce(true);
      mockIsRunning.mockResolvedValueOnce(false); // ensureDaemonRunning
      mockStartDaemon.mockReturnValueOnce(99999);

      const result = await restartDaemonIfRunning();

      expect(result.restarted).toBe(true);
      expect(result.ready).toBe(true);
      expect(result.port).toBe(18470);
      expect(result.logFile).toBe('/home/user/.discode/daemon.log');
      expect(mockStopDaemon).toHaveBeenCalledOnce();
      expect(mockStartDaemon).toHaveBeenCalledOnce();
      expect(mockWaitForReady).toHaveBeenCalledOnce();
    });

    it('restartDaemonIfRunning does nothing when daemon is not running', async () => {
      // getDaemonStatus sees daemon down — restartDaemonIfRunning returns immediately.
      mockIsRunning.mockResolvedValueOnce(false);

      const result = await restartDaemonIfRunning();

      expect(result.restarted).toBe(false);
      expect(result.ready).toBe(false);
      expect(mockStopDaemon).not.toHaveBeenCalled();
      expect(mockStartDaemon).not.toHaveBeenCalled();
    });

    it('restartDaemonIfRunning does not re-start when stop fails', async () => {
      // getDaemonStatus: daemon is up.
      // stopDaemon: returns false (process would not die, e.g. no PID file).
      // ensureDaemonRunning must NOT be called.
      mockIsRunning.mockResolvedValueOnce(true);
      mockStopDaemon.mockReturnValueOnce(false);

      const result = await restartDaemonIfRunning();

      expect(result.restarted).toBe(false);
      expect(result.ready).toBe(false);
      expect(mockStopDaemon).toHaveBeenCalledOnce();
      expect(mockStartDaemon).not.toHaveBeenCalled();
    });

    it('restartDaemonIfRunning propagates waitForReady=false when new daemon does not become ready', async () => {
      // Stop succeeds but the new daemon process never becomes ready.
      mockIsRunning.mockResolvedValueOnce(true);  // getDaemonStatus
      mockStopDaemon.mockReturnValueOnce(true);
      mockIsRunning.mockResolvedValueOnce(false); // ensureDaemonRunning
      mockWaitForReady.mockResolvedValueOnce(false);

      const result = await restartDaemonIfRunning();

      expect(result.restarted).toBe(true);
      expect(result.ready).toBe(false);
      expect(mockStartDaemon).toHaveBeenCalledOnce();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Error resilience
  // ──────────────────────────────────────────────────────────────────

  describe('Error resilience', () => {
    it('ensureDaemonRunning reports ready=false when waitForReady times out', async () => {
      mockIsRunning.mockResolvedValueOnce(false);
      mockWaitForReady.mockResolvedValueOnce(false);

      const result = await ensureDaemonRunning();

      expect(result.ready).toBe(false);
      expect(result.alreadyRunning).toBe(false);
      expect(mockStartDaemon).toHaveBeenCalledOnce();
    });

    it('stopDaemon returns false when manager stop fails', () => {
      mockStopDaemon.mockReturnValueOnce(false);

      const result = stopDaemon();

      expect(result).toBe(false);
      expect(mockStopDaemon).toHaveBeenCalledOnce();
    });

    it('getDaemonStatus is accurate immediately after a failed stop attempt', async () => {
      // Daemon is running, stop fails, daemon is still running.
      mockIsRunning.mockResolvedValueOnce(true);
      mockStopDaemon.mockReturnValueOnce(false);

      const statusBefore = await getDaemonStatus();
      expect(statusBefore.running).toBe(true);

      stopDaemon(); // fails silently — returns false

      mockIsRunning.mockResolvedValueOnce(true); // daemon still up
      const statusAfter = await getDaemonStatus();
      expect(statusAfter.running).toBe(true);
    });

    it('multiple ensureDaemonRunning calls are idempotent when daemon stays up', async () => {
      // First call starts the daemon.
      mockIsRunning.mockResolvedValueOnce(false);
      const first = await ensureDaemonRunning();
      expect(first.alreadyRunning).toBe(false);
      expect(mockStartDaemon).toHaveBeenCalledOnce();

      // Second call finds it running and skips spawn.
      mockIsRunning.mockResolvedValueOnce(true);
      const second = await ensureDaemonRunning();
      expect(second.alreadyRunning).toBe(true);
      expect(mockStartDaemon).toHaveBeenCalledOnce(); // still only one spawn
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Return-value shape consistency
  // ──────────────────────────────────────────────────────────────────

  describe('Return-value shape consistency', () => {
    it('ensureDaemonRunning always includes port and logFile regardless of path', async () => {
      // Already-running path.
      mockIsRunning.mockResolvedValueOnce(true);
      const running = await ensureDaemonRunning();
      expect(running).toHaveProperty('port', 18470);
      expect(running).toHaveProperty('logFile', '/home/user/.discode/daemon.log');

      // Start path.
      mockIsRunning.mockResolvedValueOnce(false);
      const started = await ensureDaemonRunning();
      expect(started).toHaveProperty('port', 18470);
      expect(started).toHaveProperty('logFile', '/home/user/.discode/daemon.log');
    });

    it('getDaemonStatus always includes port, logFile, and pidFile', async () => {
      for (const running of [true, false]) {
        mockIsRunning.mockResolvedValueOnce(running);
        const status = await getDaemonStatus();
        expect(status).toHaveProperty('port', 18470);
        expect(status).toHaveProperty('logFile', '/home/user/.discode/daemon.log');
        expect(status).toHaveProperty('pidFile', '/home/user/.discode/daemon.pid');
      }
    });

    it('restartDaemonIfRunning always includes port and logFile regardless of outcome', async () => {
      // Not-running path: restarted=false.
      mockIsRunning.mockResolvedValueOnce(false);
      const notRunning = await restartDaemonIfRunning();
      expect(notRunning).toHaveProperty('port', 18470);
      expect(notRunning).toHaveProperty('logFile', '/home/user/.discode/daemon.log');

      // Stop-fails path: restarted=false.
      mockIsRunning.mockResolvedValueOnce(true);
      mockStopDaemon.mockReturnValueOnce(false);
      const stopFailed = await restartDaemonIfRunning();
      expect(stopFailed).toHaveProperty('port', 18470);
      expect(stopFailed).toHaveProperty('logFile', '/home/user/.discode/daemon.log');

      // Full-restart path: restarted=true.
      mockIsRunning.mockResolvedValueOnce(true);
      mockStopDaemon.mockReturnValueOnce(true);
      mockIsRunning.mockResolvedValueOnce(false);
      const restarted = await restartDaemonIfRunning();
      expect(restarted).toHaveProperty('port', 18470);
      expect(restarted).toHaveProperty('logFile', '/home/user/.discode/daemon.log');
    });
  });
});
