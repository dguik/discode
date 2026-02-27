/**
 * Tests for docker-socket.ts — findDockerSocket, isDockerAvailable.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecSync = vi.fn();

vi.mock('child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
}));

const existingPaths = new Set<string>();
const mockExistsSync = vi.fn((p: string) => existingPaths.has(p));

vi.mock('fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
}));

import { findDockerSocket, isDockerAvailable, DOCKER_SOCKET_CANDIDATES } from '../../src/container/docker-socket.js';

beforeEach(() => {
  vi.clearAllMocks();
  existingPaths.clear();
});

// ── findDockerSocket ─────────────────────────────────────────────────

describe('findDockerSocket', () => {
  it('returns null when no sockets exist', () => {
    expect(findDockerSocket()).toBeNull();
  });

  it('returns the first matching candidate', () => {
    existingPaths.add(DOCKER_SOCKET_CANDIDATES[0]);
    existingPaths.add(DOCKER_SOCKET_CANDIDATES[1]);
    expect(findDockerSocket()).toBe(DOCKER_SOCKET_CANDIDATES[0]);
  });

  it('skips non-existing candidates and returns the next match', () => {
    existingPaths.add(DOCKER_SOCKET_CANDIDATES[2]);
    expect(findDockerSocket()).toBe(DOCKER_SOCKET_CANDIDATES[2]);
  });

  it('returns /var/run/docker.sock as last resort', () => {
    existingPaths.add('/var/run/docker.sock');
    expect(findDockerSocket()).toBe('/var/run/docker.sock');
  });
});

// ── isDockerAvailable ────────────────────────────────────────────────

describe('isDockerAvailable', () => {
  it('returns true when docker info succeeds with explicit socket', () => {
    mockExecSync.mockReturnValue('');
    expect(isDockerAvailable('/var/run/docker.sock')).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      'docker -H unix:///var/run/docker.sock info',
      expect.objectContaining({ timeout: 5000 }),
    );
  });

  it('returns false when docker info throws', () => {
    mockExecSync.mockImplementation(() => { throw new Error('Cannot connect'); });
    expect(isDockerAvailable('/var/run/docker.sock')).toBe(false);
  });

  it('returns false when no socket is found', () => {
    // findDockerSocket returns null (no paths exist)
    expect(isDockerAvailable()).toBe(false);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('uses findDockerSocket when no socketPath provided', () => {
    existingPaths.add(DOCKER_SOCKET_CANDIDATES[0]);
    mockExecSync.mockReturnValue('');
    expect(isDockerAvailable()).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining(DOCKER_SOCKET_CANDIDATES[0]),
      expect.any(Object),
    );
  });
});
