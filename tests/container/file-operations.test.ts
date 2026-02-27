/**
 * Tests for container file-operations.ts — injectFile, extractFile, injectCredentials.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process
const mockExecFileSync = vi.fn();

vi.mock('child_process', () => ({
  execFileSync: (...args: any[]) => mockExecFileSync(...args),
}));

// Mock fs
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

// Mock docker-socket
vi.mock('../../src/container/docker-socket.js', () => ({
  findDockerSocket: vi.fn().mockReturnValue('/var/run/docker.sock'),
}));

// Mock manager for assertValidContainerId
vi.mock('../../src/container/manager.js', () => ({
  assertValidContainerId: vi.fn((id: string) => {
    if (!/^[a-f0-9]{12,64}$/.test(id)) {
      throw new Error(`Invalid container ID format: "${id.substring(0, 20)}"`);
    }
  }),
}));

import { injectFile, extractFile, injectCredentials } from '../../src/container/file-operations.js';
import { findDockerSocket } from '../../src/container/docker-socket.js';

const VALID_CONTAINER_ID = 'abcdef123456';

beforeEach(() => {
  vi.clearAllMocks();
  existingPaths.clear();
  mockExistsSync.mockImplementation((p: string) => existingPaths.has(p));
});

// ── injectFile ───────────────────────────────────────────────────────

describe('injectFile', () => {
  it('injects a file into the container', () => {
    mockStatSync.mockReturnValue({ size: 1024 });

    const result = injectFile(VALID_CONTAINER_ID, '/tmp/test.txt', '/workspace', '/var/run/docker.sock');
    expect(result).toBe(true);

    // mkdir -p for target dir
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['exec', '-u', 'root', VALID_CONTAINER_ID, 'mkdir', '-p', '/workspace']),
      expect.any(Object),
    );
    // docker cp
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['cp', '/tmp/test.txt', `${VALID_CONTAINER_ID}:/workspace/`]),
      expect.any(Object),
    );
    // chown
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['chown', '1000:1000', '/workspace/test.txt']),
      expect.any(Object),
    );
  });

  it('returns false for files over 50MB', () => {
    mockStatSync.mockReturnValue({ size: 60 * 1024 * 1024 });
    const result = injectFile(VALID_CONTAINER_ID, '/tmp/large.bin', '/workspace', '/var/run/docker.sock');
    expect(result).toBe(false);
    // No docker commands should be executed
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('returns false when stat throws (file not found)', () => {
    mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });
    const result = injectFile(VALID_CONTAINER_ID, '/nonexistent', '/workspace', '/var/run/docker.sock');
    expect(result).toBe(false);
  });

  it('returns false when docker socket is not found', () => {
    (findDockerSocket as any).mockReturnValueOnce(null);
    const result = injectFile(VALID_CONTAINER_ID, '/tmp/test.txt', '/workspace');
    expect(result).toBe(false);
  });

  it('returns false when docker cp fails', () => {
    mockStatSync.mockReturnValue({ size: 1024 });
    mockExecFileSync.mockImplementationOnce(() => {}) // mkdir succeeds
      .mockImplementationOnce(() => { throw new Error('docker cp failed'); });
    const result = injectFile(VALID_CONTAINER_ID, '/tmp/test.txt', '/workspace', '/var/run/docker.sock');
    expect(result).toBe(false);
  });

  it('throws for invalid container ID', () => {
    expect(() => injectFile('bad-id!', '/tmp/test.txt', '/workspace', '/var/run/docker.sock'))
      .toThrow('Invalid container ID');
  });
});

// ── extractFile ──────────────────────────────────────────────────────

describe('extractFile', () => {
  it('extracts a file from the container', () => {
    const result = extractFile(VALID_CONTAINER_ID, '/workspace/output.txt', '/tmp/out', '/var/run/docker.sock');
    expect(result).toBe(true);
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/out', { recursive: true });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['cp', `${VALID_CONTAINER_ID}:/workspace/output.txt`, '/tmp/out/']),
      expect.any(Object),
    );
  });

  it('returns false when docker socket is not found', () => {
    (findDockerSocket as any).mockReturnValueOnce(null);
    const result = extractFile(VALID_CONTAINER_ID, '/workspace/output.txt', '/tmp/out');
    expect(result).toBe(false);
  });

  it('returns false when docker cp fails', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('docker cp failed'); });
    const result = extractFile(VALID_CONTAINER_ID, '/workspace/output.txt', '/tmp/out', '/var/run/docker.sock');
    expect(result).toBe(false);
  });

  it('throws for invalid container ID', () => {
    expect(() => extractFile('../escape', '/workspace/output.txt', '/tmp/out', '/var/run/docker.sock'))
      .toThrow('Invalid container ID');
  });
});

// ── injectCredentials ────────────────────────────────────────────────

describe('injectCredentials', () => {
  it('does nothing when docker socket is not found', () => {
    (findDockerSocket as any).mockReturnValueOnce(null);
    injectCredentials(VALID_CONTAINER_ID);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('throws for invalid container ID', () => {
    expect(() => injectCredentials('DROP TABLE;'))
      .toThrow('Invalid container ID');
  });

  it('injects settings.json when it exists', () => {
    const settingsPath = require('path').join(require('os').homedir(), '.claude', 'settings.json');
    existingPaths.add(settingsPath);
    mockReadFileSync.mockReturnValue(JSON.stringify({ theme: 'dark' }));

    injectCredentials(VALID_CONTAINER_ID, '/var/run/docker.sock');

    // Should write a temp file then docker cp it
    expect(mockWriteFileSync).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['cp']),
      expect.any(Object),
    );
    // Should set hasCompletedOnboarding
    const writtenContent = mockWriteFileSync.mock.calls[0][1];
    const parsed = JSON.parse(writtenContent);
    expect(parsed.hasCompletedOnboarding).toBe(true);
    expect(parsed.theme).toBe('dark');
    // Should clean up temp file
    expect(mockUnlinkSync).toHaveBeenCalled();
  });

  it('injects .credentials.json when it exists on disk', () => {
    const credPath = require('path').join(require('os').homedir(), '.claude', '.credentials.json');
    existingPaths.add(credPath);
    mockReadFileSync.mockReturnValue('{"token":"abc"}');

    injectCredentials(VALID_CONTAINER_ID, '/var/run/docker.sock');

    expect(mockWriteFileSync).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['cp']),
      expect.any(Object),
    );
  });

  it('injects .claude.json when it exists', () => {
    const claudeJsonPath = require('path').join(require('os').homedir(), '.claude.json');
    existingPaths.add(claudeJsonPath);
    mockReadFileSync.mockReturnValue('{"apiKey":"test"}');

    injectCredentials(VALID_CONTAINER_ID, '/var/run/docker.sock');

    expect(mockWriteFileSync).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['cp']),
      expect.any(Object),
    );
  });

  it('handles settings.json read failure gracefully', () => {
    const settingsPath = require('path').join(require('os').homedir(), '.claude', 'settings.json');
    existingPaths.add(settingsPath);
    mockReadFileSync.mockImplementation(() => { throw new Error('read fail'); });

    // Should not throw
    expect(() => injectCredentials(VALID_CONTAINER_ID, '/var/run/docker.sock')).not.toThrow();
  });
});
