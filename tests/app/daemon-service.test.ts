/**
 * Unit tests for daemon-service module.
 *
 * Covers:
 * - ensureDaemonRunning: already running path, start path
 * - getDaemonStatus: running / stopped
 * - stopDaemon: delegates to manager
 * - restartDaemonIfRunning: not running, stop fails, full restart
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────

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

import {
  ensureDaemonRunning,
  getDaemonStatus,
  stopDaemon,
  restartDaemonIfRunning,
} from '../../src/app/daemon-service.js';

// ── Tests ────────────────────────────────────────────────────────────

describe('ensureDaemonRunning', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns early when daemon is already running', async () => {
    mockIsRunning.mockResolvedValueOnce(true);

    const result = await ensureDaemonRunning();

    expect(result).toEqual({
      alreadyRunning: true,
      ready: true,
      port: 18470,
      logFile: '/home/user/.discode/daemon.log',
    });
    expect(mockStartDaemon).not.toHaveBeenCalled();
  });

  it('starts daemon and waits for ready when not running', async () => {
    mockIsRunning.mockResolvedValueOnce(false);

    const result = await ensureDaemonRunning();

    expect(result).toEqual({
      alreadyRunning: false,
      ready: true,
      port: 18470,
      logFile: '/home/user/.discode/daemon.log',
    });
    expect(mockStartDaemon).toHaveBeenCalled();
    expect(mockWaitForReady).toHaveBeenCalled();
  });

  it('reports ready=false when waitForReady times out', async () => {
    mockIsRunning.mockResolvedValueOnce(false);
    mockWaitForReady.mockResolvedValueOnce(false);

    const result = await ensureDaemonRunning();

    expect(result.ready).toBe(false);
    expect(result.alreadyRunning).toBe(false);
  });
});

describe('getDaemonStatus', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns running status with port and file paths', async () => {
    mockIsRunning.mockResolvedValueOnce(true);

    const result = await getDaemonStatus();

    expect(result).toEqual({
      running: true,
      port: 18470,
      logFile: '/home/user/.discode/daemon.log',
      pidFile: '/home/user/.discode/daemon.pid',
    });
  });

  it('returns not running status', async () => {
    mockIsRunning.mockResolvedValueOnce(false);

    const result = await getDaemonStatus();

    expect(result.running).toBe(false);
  });
});

describe('stopDaemon', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to defaultDaemonManager.stopDaemon', () => {
    mockStopDaemon.mockReturnValueOnce(true);
    expect(stopDaemon()).toBe(true);
    expect(mockStopDaemon).toHaveBeenCalled();
  });

  it('returns false when stop fails', () => {
    mockStopDaemon.mockReturnValueOnce(false);
    expect(stopDaemon()).toBe(false);
  });
});

describe('restartDaemonIfRunning', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not restart when daemon is not running', async () => {
    mockIsRunning.mockResolvedValueOnce(false);

    const result = await restartDaemonIfRunning();

    expect(result.restarted).toBe(false);
    expect(result.ready).toBe(false);
    expect(mockStopDaemon).not.toHaveBeenCalled();
  });

  it('does not restart when stop fails', async () => {
    mockIsRunning.mockResolvedValueOnce(true);
    mockStopDaemon.mockReturnValueOnce(false);

    const result = await restartDaemonIfRunning();

    expect(result.restarted).toBe(false);
    expect(result.ready).toBe(false);
    expect(mockStopDaemon).toHaveBeenCalled();
    expect(mockStartDaemon).not.toHaveBeenCalled();
  });

  it('stops and restarts when daemon is running', async () => {
    // getDaemonStatus call
    mockIsRunning.mockResolvedValueOnce(true);
    // ensureDaemonRunning call
    mockIsRunning.mockResolvedValueOnce(false);
    mockStopDaemon.mockReturnValueOnce(true);

    const result = await restartDaemonIfRunning();

    expect(result.restarted).toBe(true);
    expect(result.ready).toBe(true);
    expect(mockStopDaemon).toHaveBeenCalled();
    expect(mockStartDaemon).toHaveBeenCalled();
  });
});
