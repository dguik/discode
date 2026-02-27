/**
 * Unit tests for container execution functions.
 *
 * Tests startContainerBackground and execInContainer with mocked child_process/fs.
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

vi.mock('fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  statSync: vi.fn(),
  mkdirSync: vi.fn(),
  mkdtempSync: vi.fn((_prefix: string) => '/tmp/discode-inject-XXXXXX'),
  rmdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
}));

vi.mock('../../src/container/image.js', () => ({
  ensureImage: vi.fn(),
  imageTagFor: (agentType: string) => `discode-agent-${agentType}:1`,
}));

import {
  startContainerBackground,
  execInContainer,
} from '../../src/container/manager.js';

describe('container/manager — execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockReset();
    mockExecFileSync.mockReset();
    mockExistsSync.mockImplementation((p: string) => existingPaths.has(p));
    existingPaths.clear();
  });

  describe('startContainerBackground', () => {
    it('returns false when no socket found', () => {
      expect(startContainerBackground('abcdef123456')).toBe(false);
    });

    it('runs docker start and returns true', () => {
      existingPaths.add('/var/run/docker.sock');

      expect(startContainerBackground('abcdef123456')).toBe(true);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['start', 'abcdef123456']),
        expect.objectContaining({ timeout: 10_000 }),
      );
    });

    it('returns false when start throws', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockImplementation(() => { throw new Error('already running'); });

      expect(startContainerBackground('abcdef123456')).toBe(false);
    });
  });

  describe('execInContainer', () => {
    it('throws when no socket found', () => {
      expect(() => execInContainer('abcdef123456', 'ls -la')).toThrow('Docker socket not found');
    });

    it('returns trimmed stdout', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('  file1.txt\nfile2.txt  \n');

      const result = execInContainer('abcdef123456', 'ls -la');
      expect(result).toBe('file1.txt\nfile2.txt');
    });

    it('passes shell-escaped command to docker exec', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('output\n');

      execInContainer('abcdef123456', 'cat /workspace/test.txt', '/var/run/docker.sock');

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['-H', 'unix:///var/run/docker.sock', 'exec', 'abcdef123456', 'sh', '-c', 'cat /workspace/test.txt']),
        expect.objectContaining({ encoding: 'utf-8', timeout: 30_000 }),
      );
    });
  });
});
