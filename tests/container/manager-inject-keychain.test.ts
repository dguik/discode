/**
 * Unit tests for Keychain fallback in injectCredentials.
 *
 * Extracted from manager-inject.test.ts for change isolation.
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
} from '../../src/container/manager.js';

describe('container/manager — Keychain fallback', () => {
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

    it('falls back to macOS Keychain when credentials.json missing on darwin', () => {
      existingPaths.add('/var/run/docker.sock');

      const oauthJson = '{"claudeAiOauth":{"accessToken":"sk-test","refreshToken":"sk-ref"}}';
      mockExecFileSync.mockReturnValue(oauthJson);

      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        injectCredentials('abcdef123456', '/var/run/docker.sock');
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
      }

      const securityCalls = mockExecFileSync.mock.calls.filter(
        (c: any[]) => c[0] === 'security' && Array.isArray(c[1]) && c[1].includes('find-generic-password'),
      );
      expect(securityCalls).toHaveLength(1);
      expect(securityCalls[0][1]).toContain('Claude Code-credentials');

      const dockerCpCalls = mockExecFileSync.mock.calls.filter(
        (c: any[]) => c[0] === 'docker' && Array.isArray(c[1]) && c[1].some((a: string) => a.includes('.credentials.json')),
      );
      expect(dockerCpCalls).toHaveLength(1);
    });

    it('does not attempt Keychain fallback on linux', () => {
      existingPaths.add('/var/run/docker.sock');

      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'linux' });
      try {
        injectCredentials('abcdef123456', '/var/run/docker.sock');
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
      }

      const securityCalls = mockExecFileSync.mock.calls.filter(
        (c: any[]) => c[0] === 'security',
      );
      expect(securityCalls).toHaveLength(0);
    });

    it('prefers .credentials.json file over Keychain on darwin', () => {
      existingPaths.add('/var/run/docker.sock');
      existingPaths.add(join(home, '.claude', '.credentials.json'));
      mockReadFileSync.mockReturnValue('{"claudeAiOauth":{"accessToken":"from-file"}}');

      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        injectCredentials('abcdef123456', '/var/run/docker.sock');
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
      }

      const dockerCpCalls = mockExecFileSync.mock.calls.filter(
        (c: any[]) => c[0] === 'docker' && Array.isArray(c[1]) && c[1].some((a: string) => a.includes('.credentials.json')),
      );
      expect(dockerCpCalls).toHaveLength(1);
      const securityCalls = mockExecFileSync.mock.calls.filter(
        (c: any[]) => c[0] === 'security' && Array.isArray(c[1]) && c[1].includes('find-generic-password'),
      );
      expect(securityCalls).toHaveLength(0);
    });

    it('Keychain fallback writes raw JSON to container as .credentials.json', () => {
      existingPaths.add('/var/run/docker.sock');
      const oauthJson = '{"claudeAiOauth":{"accessToken":"sk-oat","refreshToken":"sk-ort","expiresAt":9999}}';
      mockExecFileSync.mockReturnValue(oauthJson);

      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        injectCredentials('abcdef123456', '/var/run/docker.sock');
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
      }

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('discode-inject-'),
        oauthJson,
        expect.objectContaining({ mode: 0o600 }),
      );
      const dockerCpCalls = mockExecFileSync.mock.calls.filter(
        (c: any[]) => c[0] === 'docker' && Array.isArray(c[1]) && c[1].some((a: string) => a.includes('.credentials.json')),
      );
      expect(dockerCpCalls).toHaveLength(1);
      expect(dockerCpCalls[0][1].some((a: string) => a.includes('/home/coder/.claude/.credentials.json'))).toBe(true);
    });

    it('Keychain fallback skips when security command returns empty', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('   \n');

      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        injectCredentials('abcdef123456', '/var/run/docker.sock');
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
      }

      const dockerCpCalls = mockExecFileSync.mock.calls.filter(
        (c: any[]) => c[0] === 'docker',
      );
      expect(dockerCpCalls).toHaveLength(0);
    });

    it('Keychain fallback handles security command failure gracefully', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (cmd === 'security') throw new Error('keychain locked');
        return '';
      });

      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        expect(() => injectCredentials('abcdef123456', '/var/run/docker.sock')).not.toThrow();
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    });

    it('Keychain fallback uses 5s timeout for security command', () => {
      existingPaths.add('/var/run/docker.sock');
      mockExecFileSync.mockReturnValue('{"claudeAiOauth":{}}');

      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        injectCredentials('abcdef123456', '/var/run/docker.sock');
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
      }

      const securityCall = mockExecFileSync.mock.calls.find(
        (c: any[]) => c[0] === 'security',
      );
      expect(securityCall).toBeDefined();
      // execFileSync('security', [...args], options) — options is the 3rd arg
      expect(securityCall![2]).toEqual(expect.objectContaining({
        timeout: 5_000,
        encoding: 'utf-8',
      }));
    });
  });
});
