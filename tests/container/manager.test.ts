/**
 * Unit tests for container manager module — Docker utilities.
 *
 * Tests Docker socket discovery, command building, and container lifecycle
 * functions with mocked execSync/execFileSync/fs calls.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process and fs before importing the module under test
const mockExecSync = vi.fn();
const mockExecFileSync = vi.fn();

vi.mock('child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
  execFileSync: (...args: any[]) => mockExecFileSync(...args),
}));

const existingPaths = new Set<string>();
const mockExistsSync = vi.fn((p: string) => existingPaths.has(p));
const mockStatSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();

vi.mock('fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  statSync: (...args: any[]) => mockStatSync(...args),
  mkdirSync: (...args: any[]) => mockMkdirSync(...args),
  mkdtempSync: vi.fn((_prefix: string) => '/tmp/discode-inject-XXXXXX'),
  rmdirSync: vi.fn(),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  unlinkSync: (...args: any[]) => mockUnlinkSync(...args),
  realpathSync: vi.fn((p: string) => p),
}));

const mockEnsureImage = vi.fn();

vi.mock('../../src/container/image.js', () => ({
  ensureImage: (...args: any[]) => mockEnsureImage(...args),
  imageTagFor: (agentType: string) => `discode-agent-${agentType}:1`,
}));

import {
  findDockerSocket,
  isDockerAvailable,
  buildDockerStartCommand,
  isContainerRunning,
  containerExists,
  stopContainer,
  removeContainer,
  createContainer,
  WORKSPACE_DIR,
} from '../../src/container/manager.js';

describe('container/manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReset();
    mockExecFileSync.mockReset();
    mockStatSync.mockReset();
    mockReadFileSync.mockReset();
    mockEnsureImage.mockReset();
    mockExistsSync.mockImplementation((p: string) => existingPaths.has(p));
    existingPaths.clear();
  });

  describe('findDockerSocket', () => {
    it('returns null when no socket files exist', () => {
      expect(findDockerSocket()).toBeNull();
    });

    it('returns the first existing socket path', () => {
      const home = process.env.HOME || '/Users/test';
      existingPaths.add(`${home}/.docker/run/docker.sock`);

      const result = findDockerSocket();
      expect(result).toBe(`${home}/.docker/run/docker.sock`);
    });

    it('prefers OrbStack over Docker Desktop', () => {
      const home = process.env.HOME || '/Users/test';
      existingPaths.add(`${home}/.orbstack/run/docker.sock`);
      existingPaths.add(`${home}/.docker/run/docker.sock`);

      const result = findDockerSocket();
      expect(result).toBe(`${home}/.orbstack/run/docker.sock`);
    });

    it('falls back to /var/run/docker.sock', () => {
      existingPaths.add('/var/run/docker.sock');

      const result = findDockerSocket();
      expect(result).toBe('/var/run/docker.sock');
    });
  });

  describe('isDockerAvailable', () => {
    it('returns false when no socket found', () => {
      expect(isDockerAvailable()).toBe(false);
    });

    it('returns true when docker info succeeds', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecSync.mockReturnValue(Buffer.from(''));

      expect(isDockerAvailable()).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith(
        'docker -H unix:///var/run/docker.sock info',
        expect.objectContaining({ timeout: 5000 }),
      );
    });

    it('returns false when docker info throws', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecSync.mockImplementation(() => { throw new Error('connection refused'); });

      expect(isDockerAvailable()).toBe(false);
    });

    it('uses explicit socket path when provided', () => {
      mockExecSync.mockReturnValue(Buffer.from(''));

      expect(isDockerAvailable('/custom/docker.sock')).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith(
        'docker -H unix:///custom/docker.sock info',
        expect.anything(),
      );
    });
  });

  describe('buildDockerStartCommand', () => {
    it('builds docker start -ai command with socket', () => {
      existingPaths.add('/var/run/docker.sock');
      const cmd = buildDockerStartCommand('abcdef123456', '/var/run/docker.sock');

      expect(cmd).toBe('docker -H unix:///var/run/docker.sock start -ai abcdef123456');
    });

    it('builds basic command when no socket found', () => {
      const cmd = buildDockerStartCommand('abcdef123456');

      expect(cmd).toBe('docker start -ai abcdef123456');
    });
  });

  describe('isContainerRunning', () => {
    it('returns false when no socket available', () => {
      expect(isContainerRunning('abcdef123456')).toBe(false);
    });

    it('returns true when inspect shows Running=true', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('true\n');

      expect(isContainerRunning('abcdef123456')).toBe(true);
    });

    it('returns false when inspect shows Running=false', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('false\n');

      expect(isContainerRunning('abcdef123456')).toBe(false);
    });

    it('returns false when inspect throws', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockImplementation(() => { throw new Error('no such container'); });

      expect(isContainerRunning('abcdef123456')).toBe(false);
    });
  });

  describe('containerExists', () => {
    it('returns false when no socket', () => {
      expect(containerExists('abcdef123456')).toBe(false);
    });

    it('returns true when inspect succeeds', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('');

      expect(containerExists('abcdef123456')).toBe(true);
    });

    it('returns false when inspect throws', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockImplementation(() => { throw new Error('no such container'); });

      expect(containerExists('abcdef123456')).toBe(false);
    });
  });

  describe('stopContainer', () => {
    it('returns false when no socket', () => {
      expect(stopContainer('abcdef123456')).toBe(false);
    });

    it('returns true on success', () => {
      existingPaths.add('/var/run/docker.sock');

      expect(stopContainer('abcdef123456')).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['stop', '-t', '10', 'abcdef123456']),
        expect.anything(),
      );
    });

    it('returns false when stop throws', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockImplementation(() => { throw new Error('not running'); });

      expect(stopContainer('abcdef123456')).toBe(false);
    });
  });

  describe('removeContainer', () => {
    it('returns false when no socket', () => {
      expect(removeContainer('abcdef123456')).toBe(false);
    });

    it('returns true on force remove', () => {
      existingPaths.add('/var/run/docker.sock');

      expect(removeContainer('abcdef123456')).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['rm', '-f', 'abcdef123456']),
        expect.anything(),
      );
    });
  });

  describe('WORKSPACE_DIR', () => {
    it('is /workspace', () => {
      expect(WORKSPACE_DIR).toBe('/workspace');
    });
  });
});
