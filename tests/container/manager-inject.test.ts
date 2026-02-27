/**
 * Unit tests for container injection/extraction functions.
 *
 * Tests injectCredentials, injectFile, and extractFile with mocked fs/child_process.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

vi.mock('../../src/container/image.js', () => ({
  ensureImage: vi.fn(),
  imageTagFor: (agentType: string) => `discode-agent-${agentType}:1`,
}));

import { join } from 'path';
import { homedir } from 'os';

import {
  injectCredentials,
  injectFile,
  extractFile,
} from '../../src/container/manager.js';

describe('container/manager — injection & extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReset();
    mockExecFileSync.mockReset();
    mockStatSync.mockReset();
    mockReadFileSync.mockReset();
    mockExistsSync.mockImplementation((p: string) => existingPaths.has(p));
    existingPaths.clear();
  });

  describe('injectCredentials', () => {
    const home = homedir();

    it('does nothing when no socket found', () => {
      injectCredentials('abcdef123456');
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('injects settings.json with hasCompletedOnboarding=true via docker cp', () => {
      existingPaths.add('/var/run/docker.sock');
      existingPaths.add(join(home, '.claude', 'settings.json'));
      mockReadFileSync.mockReturnValue('{"theme":"dark"}');

      injectCredentials('abcdef123456', '/var/run/docker.sock');

      expect(mockReadFileSync).toHaveBeenCalledWith(
        join(home, '.claude', 'settings.json'),
        'utf-8',
      );
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const written = mockWriteFileSync.mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.hasCompletedOnboarding).toBe(true);
      expect(parsed.theme).toBe('dark');
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['cp']),
        expect.anything(),
      );
      // Verify the container path is in the args
      const cpCall = mockExecFileSync.mock.calls[0];
      expect(cpCall[1].some((a: string) => a.includes('abcdef123456:/home/coder/.claude/settings.json'))).toBe(true);
      expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
    });

    it('injects .credentials.json when it exists', () => {
      existingPaths.add('/var/run/docker.sock');
      existingPaths.add(join(home, '.claude', '.credentials.json'));
      mockReadFileSync.mockReturnValue('{"oauth":"token123"}');

      injectCredentials('abcdef123456', '/var/run/docker.sock');

      const cpCall = mockExecFileSync.mock.calls[0];
      expect(cpCall[1].some((a: string) => a.includes('abcdef123456:/home/coder/.claude/.credentials.json'))).toBe(true);
    });

    it('injects .claude.json when it exists', () => {
      existingPaths.add('/var/run/docker.sock');
      existingPaths.add(join(home, '.claude.json'));
      mockReadFileSync.mockReturnValue('{"apiKey":"sk-xxx"}');

      injectCredentials('abcdef123456', '/var/run/docker.sock');

      const dockerCpCalls = mockExecFileSync.mock.calls.filter(
        (c: any[]) => c[0] === 'docker' && Array.isArray(c[1]) && c[1].some((a: string) => a.includes('.claude.json')),
      );
      expect(dockerCpCalls).toHaveLength(1);
      expect(dockerCpCalls[0][1].some((a: string) => a.includes('abcdef123456:/home/coder/.claude.json'))).toBe(true);
    });

    it('injects all three when all exist', () => {
      existingPaths.add('/var/run/docker.sock');
      existingPaths.add(join(home, '.claude', 'settings.json'));
      existingPaths.add(join(home, '.claude', '.credentials.json'));
      existingPaths.add(join(home, '.claude.json'));
      mockReadFileSync.mockReturnValue('{}');

      injectCredentials('abcdef123456', '/var/run/docker.sock');

      expect(mockExecFileSync).toHaveBeenCalledTimes(3);
      expect(mockWriteFileSync).toHaveBeenCalledTimes(3);
      expect(mockUnlinkSync).toHaveBeenCalledTimes(3);
    });

    it('continues silently when docker cp throws (best-effort)', () => {
      existingPaths.add('/var/run/docker.sock');
      existingPaths.add(join(home, '.claude', 'settings.json'));
      mockReadFileSync.mockReturnValue('{"theme":"dark"}');
      mockExecFileSync.mockImplementation(() => { throw new Error('docker cp failed'); });

      expect(() => injectCredentials('abcdef123456', '/var/run/docker.sock')).not.toThrow();
      expect(mockUnlinkSync).toHaveBeenCalled();
    });

    it('cleans up temp file even when docker cp fails for each credential', () => {
      existingPaths.add('/var/run/docker.sock');
      existingPaths.add(join(home, '.claude', 'settings.json'));
      existingPaths.add(join(home, '.claude', '.credentials.json'));
      existingPaths.add(join(home, '.claude.json'));
      mockReadFileSync.mockReturnValue('{}');
      mockExecFileSync.mockImplementation(() => { throw new Error('docker cp failed'); });

      injectCredentials('abcdef123456', '/var/run/docker.sock');

      expect(mockWriteFileSync).toHaveBeenCalledTimes(3);
      expect(mockUnlinkSync).toHaveBeenCalledTimes(3);
    });

    it('does not call docker cp when settings.json is invalid JSON', () => {
      existingPaths.add('/var/run/docker.sock');
      existingPaths.add(join(home, '.claude', 'settings.json'));
      mockReadFileSync.mockReturnValue('not valid json{{{');

      expect(() => injectCredentials('abcdef123456', '/var/run/docker.sock')).not.toThrow();
      const dockerCpCalls = mockExecFileSync.mock.calls.filter(
        (c: any[]) => c[0] === 'docker' && Array.isArray(c[1]) && c[1].includes('cp'),
      );
      expect(dockerCpCalls).toHaveLength(0);
    });

    it('skips files that do not exist on host', () => {
      existingPaths.add('/var/run/docker.sock');

      injectCredentials('abcdef123456', '/var/run/docker.sock');

      expect(mockReadFileSync).not.toHaveBeenCalled();
      const dockerCpCalls = mockExecFileSync.mock.calls.filter(
        (c: any[]) => c[0] === 'docker' && Array.isArray(c[1]) && c[1].includes('cp'),
      );
      expect(dockerCpCalls).toHaveLength(0);
    });
  });

  describe('injectFile', () => {
    it('returns false when no socket found', () => {
      expect(injectFile('abcdef123456', '/host/file.png', '/container/dir')).toBe(false);
    });

    it('returns false when file exceeds 50MB', () => {
      existingPaths.add('/var/run/docker.sock');
      mockStatSync.mockReturnValue({ size: 51 * 1024 * 1024 });

      expect(injectFile('abcdef123456', '/host/big.bin', '/container/dir', '/var/run/docker.sock')).toBe(false);
    });

    it('returns false when stat throws (file not found)', () => {
      existingPaths.add('/var/run/docker.sock');
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });

      expect(injectFile('abcdef123456', '/host/missing.txt', '/dir', '/var/run/docker.sock')).toBe(false);
    });

    it('creates directory, copies file, and fixes ownership', () => {
      existingPaths.add('/var/run/docker.sock');
      mockStatSync.mockReturnValue({ size: 1024 });

      const result = injectFile(
        'abcdef123456',
        '/host/files/img.png',
        '/workspace/.discode/files',
        '/var/run/docker.sock',
      );

      expect(result).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledTimes(3);
      // mkdir -p
      expect(mockExecFileSync.mock.calls[0][1]).toEqual(
        expect.arrayContaining(['mkdir', '-p', '/workspace/.discode/files']),
      );
      // docker cp
      expect(mockExecFileSync.mock.calls[1][1]).toEqual(
        expect.arrayContaining(['cp', '/host/files/img.png', 'abcdef123456:/workspace/.discode/files/']),
      );
      // chown
      expect(mockExecFileSync.mock.calls[2][1]).toEqual(
        expect.arrayContaining(['chown', '1000:1000', '/workspace/.discode/files/img.png']),
      );
    });

    it('returns false when docker cp throws', () => {
      existingPaths.add('/var/run/docker.sock');
      mockStatSync.mockReturnValue({ size: 1024 });
      mockExecFileSync.mockImplementation(() => { throw new Error('container not running'); });

      expect(injectFile('abcdef123456', '/host/file.txt', '/dir', '/var/run/docker.sock')).toBe(false);
    });

    it('accepts files exactly at 50MB limit', () => {
      existingPaths.add('/var/run/docker.sock');
      mockStatSync.mockReturnValue({ size: 50 * 1024 * 1024 });

      const result = injectFile('abcdef123456', '/host/file.bin', '/dir', '/var/run/docker.sock');
      expect(result).toBe(true);
    });
  });

  describe('extractFile', () => {
    it('returns false when no socket found', () => {
      expect(extractFile('abcdef123456', '/container/file.txt', '/host/dir')).toBe(false);
    });

    it('creates host directory and copies file from container', () => {
      existingPaths.add('/var/run/docker.sock');

      const result = extractFile(
        'abcdef123456',
        '/workspace/output.txt',
        '/host/output',
        '/var/run/docker.sock',
      );

      expect(result).toBe(true);
      expect(mockMkdirSync).toHaveBeenCalledWith('/host/output', { recursive: true });
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['cp', 'abcdef123456:/workspace/output.txt', '/host/output/']),
        expect.anything(),
      );
    });

    it('returns false when docker cp throws', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockImplementation(() => { throw new Error('no such container'); });

      expect(extractFile('abcdef123456', '/container/f.txt', '/host', '/var/run/docker.sock')).toBe(false);
    });
  });
});
