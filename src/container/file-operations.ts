/**
 * Container file injection and extraction operations.
 *
 * Uses `docker cp` for host ↔ container file transfer.
 * Non-root `coder` user (uid/gid 1000:1000) inside containers.
 */

import { randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, mkdirSync, mkdtempSync, rmdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir, tmpdir } from 'os';
import { findDockerSocket } from './docker-socket.js';
import { assertValidContainerId } from './manager.js';

const MAX_INJECT_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const CONTAINER_UID = '1000';
const CONTAINER_GID = '1000';

/**
 * Inject credentials (Claude OAuth/API key) into a container.
 *
 * Uses `docker cp` so it works on stopped containers (before `docker start`).
 * Reads credentials from the host ~/.claude config and copies them into the
 * container filesystem.
 */
export function injectCredentials(containerId: string, socketPath?: string): void {
  assertValidContainerId(containerId);
  const sock = socketPath || findDockerSocket();
  if (!sock) return;

  const copyToContainer = (content: string, containerPath: string): void => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'discode-inject-'), { mode: 0o700 } as any);
    const tmp = join(tmpDir, randomBytes(16).toString('hex'));
    try {
      writeFileSync(tmp, content, { mode: 0o600 });
      execFileSync('docker', ['-H', `unix://${sock}`, 'cp', tmp, `${containerId}:${containerPath}`], {
        timeout: 10_000,
      });
    } finally {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      try { rmdirSync(tmpDir); } catch { /* ignore */ }
    }
  };

  // Inject Claude settings with onboarding bypass
  const claudeDir = join(homedir(), '.claude');
  const settingsPath = join(claudeDir, 'settings.json');

  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      settings.hasCompletedOnboarding = true;
      copyToContainer(JSON.stringify(settings, null, 2), '/home/coder/.claude/settings.json');
    } catch {
      // Non-critical: credentials injection is best-effort
    }
  }

  // Inject Claude .credentials.json — try plaintext file first, then macOS Keychain.
  // Claude Code on Linux uses ~/.claude/.credentials.json for plaintext credential storage.
  const credentialsPath = join(claudeDir, '.credentials.json');
  if (existsSync(credentialsPath)) {
    try {
      copyToContainer(readFileSync(credentialsPath, 'utf-8'), '/home/coder/.claude/.credentials.json');
    } catch {
      // Non-critical
    }
  } else if (process.platform === 'darwin') {
    // Claude Code stores OAuth tokens in macOS Keychain, not on disk.
    // Extract them so the container (Linux) can read them as a file.
    try {
      const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
        timeout: 5_000,
        encoding: 'utf-8',
      }).trim();
      if (raw) {
        copyToContainer(raw, '/home/coder/.claude/.credentials.json');
      }
    } catch {
      // Keychain entry may not exist — non-critical
    }
  }

  // Inject .claude.json (API key config) if it exists
  const claudeJsonPath = join(homedir(), '.claude.json');
  if (existsSync(claudeJsonPath)) {
    try {
      copyToContainer(readFileSync(claudeJsonPath, 'utf-8'), '/home/coder/.claude.json');
    } catch {
      // Non-critical
    }
  }
}

/**
 * Inject a file into the container at the given path.
 * Skips files over MAX_INJECT_FILE_SIZE.
 */
export function injectFile(
  containerId: string,
  hostPath: string,
  containerDir: string,
  socketPath?: string,
): boolean {
  assertValidContainerId(containerId);
  const sock = socketPath || findDockerSocket();
  if (!sock) return false;

  try {
    const stat = statSync(hostPath);
    if (stat.size > MAX_INJECT_FILE_SIZE) {
      console.warn(`Skipping file injection (>50MB): ${hostPath}`);
      return false;
    }
  } catch {
    return false;
  }

  try {
    // Ensure target directory exists (run as root so we can create dirs owned by anyone)
    execFileSync('docker', ['-H', `unix://${sock}`, 'exec', '-u', 'root', containerId, 'mkdir', '-p', containerDir], {
      timeout: 5000,
    });

    // Use docker cp for file transfer
    execFileSync('docker', ['-H', `unix://${sock}`, 'cp', hostPath, `${containerId}:${containerDir}/`], {
      timeout: 30_000,
    });

    // Fix ownership (run as root)
    const filename = basename(hostPath);
    execFileSync('docker', ['-H', `unix://${sock}`, 'exec', '-u', 'root', containerId, 'chown', `${CONTAINER_UID}:${CONTAINER_GID}`, `${containerDir}/${filename}`], {
      timeout: 5000,
    });

    return true;
  } catch (error) {
    console.warn(`Failed to inject file into container: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Extract a file from the container to the host.
 */
export function extractFile(
  containerId: string,
  containerPath: string,
  hostDir: string,
  socketPath?: string,
): boolean {
  assertValidContainerId(containerId);
  const sock = socketPath || findDockerSocket();
  if (!sock) return false;

  try {
    mkdirSync(hostDir, { recursive: true });
    execFileSync('docker', ['-H', `unix://${sock}`, 'cp', `${containerId}:${containerPath}`, `${hostDir}/`], {
      timeout: 30_000,
    });
    return true;
  } catch {
    return false;
  }
}
