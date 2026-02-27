/**
 * Unit tests for container manager module — createContainer.
 *
 * Tests container creation with mocked execSync/execFileSync/fs calls.
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

describe('container/manager — createContainer', () => {
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

  describe('createContainer', () => {
    it('throws when no socket found', () => {
      expect(() => createContainer({
        agentType: 'claude',
        containerName: 'test-container',
        projectPath: '/test/path',
      })).toThrow('Docker socket not found');
    });

    it('calls ensureImage before creating', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('abc123def456789\n');

      createContainer({
        agentType: 'claude',
        containerName: 'test-container',
        projectPath: '/test/path',
      });

      expect(mockEnsureImage).toHaveBeenCalledWith('claude', '/var/run/docker.sock');
    });

    it('returns truncated 12-char container ID', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('abc123def456789extrachars\n');

      const id = createContainer({
        agentType: 'claude',
        containerName: 'test-container',
        projectPath: '/test/path',
      });

      expect(id).toBe('abc123def456');
    });

    it('passes correct docker create args', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('abc123def456\n');

      createContainer({
        agentType: 'claude',
        containerName: 'my-container',
        projectPath: '/home/user/project',
        env: { DISCODE_PROJECT: 'myapp', FOO: 'bar' },
      });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining([
          '-H', 'unix:///var/run/docker.sock',
          'create',
          '--name', 'my-container',
          '-it',
          '-w', '/workspace',
          '-v', '/home/user/project:/workspace',
          '--add-host', 'host.docker.internal:host-gateway',
          '-u', '1000:1000',
          '-e', 'DISCODE_PROJECT=myapp',
          '-e', 'FOO=bar',
          'discode-agent-claude:1',
        ]),
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it('creates container without env flags when env is undefined', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('abc123def456\n');

      createContainer({
        agentType: 'claude',
        containerName: 'test',
        projectPath: '/test',
      });

      const args = mockExecFileSync.mock.calls[0][1] as string[];
      expect(args).not.toContain('-e');
    });

    it('uses explicit socketPath when provided', () => {
      mockExecFileSync.mockReturnValue('abc123def456\n');

      createContainer({
        agentType: 'claude',
        containerName: 'test',
        projectPath: '/test',
        socketPath: '/custom/docker.sock',
      });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['-H', 'unix:///custom/docker.sock']),
        expect.anything(),
      );
    });

    it('removes stale container with same name before creating', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('abc123def456\n');

      createContainer({
        agentType: 'claude',
        containerName: 'my-agent',
        projectPath: '/test',
      });

      const rmCall = mockExecFileSync.mock.calls[0];
      expect(rmCall[0]).toBe('docker');
      expect(rmCall[1]).toContain('rm');
      expect(rmCall[1]).toContain('-f');
      expect(rmCall[1]).toContain('my-agent');
    });

    it('proceeds with create even when rm -f fails (no stale container)', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync
        .mockImplementationOnce(() => { throw new Error('No such container'); })
        .mockReturnValueOnce('abc123def456\n');

      const id = createContainer({
        agentType: 'claude',
        containerName: 'fresh',
        projectPath: '/test',
      });

      expect(id).toBe('abc123def456');
    });

    it('passes command as -c flag when provided', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('abc123def456\n');

      createContainer({
        agentType: 'claude',
        containerName: 'test-agent',
        projectPath: '/test',
        command: 'claude --dangerously-skip-permissions',
      });

      const createCall = mockExecFileSync.mock.calls.find(
        (c: any[]) => (c[1] as string[]).includes('create'),
      );
      const args = createCall![1] as string[];
      const imageIdx = args.indexOf('discode-agent-claude:1');
      expect(imageIdx).toBeGreaterThan(-1);
      expect(args[imageIdx + 1]).toBe('-c');
      expect(args[imageIdx + 2]).toBe('claude --dangerously-skip-permissions');
    });

    it('does not pass -c flag when command is undefined', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('abc123def456\n');

      createContainer({
        agentType: 'claude',
        containerName: 'test',
        projectPath: '/test',
      });

      const createCall = mockExecFileSync.mock.calls.find(
        (c: any[]) => (c[1] as string[]).includes('create'),
      );
      const args = createCall![1] as string[];
      const imageIdx = args.indexOf('discode-agent-claude:1');
      expect(args.length).toBe(imageIdx + 1);
    });

    it('passes volume mounts when provided', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('abc123def456\n');

      createContainer({
        agentType: 'claude',
        containerName: 'test-vol',
        projectPath: '/test',
        volumes: [
          '/host/plugin:/home/coder/.claude/plugins/bridge:ro',
          '/host/data:/data',
        ],
      });

      const createCall = mockExecFileSync.mock.calls.find(
        (c: any[]) => (c[1] as string[]).includes('create'),
      );
      const args = createCall![1] as string[];
      const vIndices = args.reduce<number[]>((acc, arg, i) => {
        if (arg === '-v' && args[i + 1]?.includes(':')) acc.push(i);
        return acc;
      }, []);
      expect(vIndices.length).toBeGreaterThanOrEqual(3);
      expect(args).toContain('/host/plugin:/home/coder/.claude/plugins/bridge:ro');
      expect(args).toContain('/host/data:/data');
    });

    it('passes both command and volumes together', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('abc123def456\n');

      createContainer({
        agentType: 'claude',
        containerName: 'test-full',
        projectPath: '/project',
        command: 'claude --plugin-dir /home/coder/.claude/plugins/bridge',
        volumes: ['/host/bridge:/home/coder/.claude/plugins/bridge:ro'],
      });

      const createCall = mockExecFileSync.mock.calls.find(
        (c: any[]) => (c[1] as string[]).includes('create'),
      );
      const args = createCall![1] as string[];
      expect(args).toContain('/host/bridge:/home/coder/.claude/plugins/bridge:ro');
      const imageIdx = args.indexOf('discode-agent-claude:1');
      expect(args[imageIdx + 1]).toBe('-c');
      expect(args[imageIdx + 2]).toBe('claude --plugin-dir /home/coder/.claude/plugins/bridge');
    });
  });
});
