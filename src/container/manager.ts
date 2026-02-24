/**
 * Docker container lifecycle management.
 *
 * Creates, starts, stops, and removes containers.
 *
 * Key constraints:
 * - Docker socket: tries OrbStack -> Docker Desktop -> Colima -> Lima
 * - Non-root `coder` user inside containers
 * - /workspace is the hardcoded working directory
 * - uid/gid mapped to 1000:1000 (the coder user)
 */

import { execSync, execFileSync } from 'child_process';
import type { AgentType } from '../agents/base.js';
import { imageTagFor, ensureImage } from './image.js';
import { findDockerSocket } from './docker-socket.js';

const WORKSPACE_DIR = '/workspace';
const CONTAINER_UID = '1000';
const CONTAINER_GID = '1000';

// Re-export extracted modules for backward compatibility
export { findDockerSocket, isDockerAvailable } from './docker-socket.js';
export { injectCredentials, injectFile, extractFile } from './file-operations.js';
export { injectChromeMcpBridge } from './mcp-bridge-injector.js';

export interface ContainerCreateOptions {
  containerName: string;
  projectPath: string;
  agentType: AgentType;
  socketPath?: string;
  env?: Record<string, string>;
  /** Additional -v volume mounts (e.g. host:container:ro). */
  volumes?: string[];
  /** Shell command to run inside the container (passed as CMD via `-c`). */
  command?: string;
}

/**
 * Create and prepare a container for an agent session.
 *
 * The container is created in stopped state with:
 * - Interactive tty (-it) for `docker start -ai`
 * - /workspace bind-mounted from the project path
 * - Environment variables for bridge communication
 * - host.docker.internal mapped for host access
 */
export function createContainer(options: ContainerCreateOptions): string {
  const sock = options.socketPath || findDockerSocket();
  if (!sock) {
    throw new Error('Docker socket not found. Is Docker running?');
  }

  ensureImage(options.agentType, sock);

  // Remove stale container with the same name (left over from a previous run)
  try {
    execFileSync('docker', ['-H', `unix://${sock}`, 'rm', '-f', options.containerName], {
      timeout: 10_000,
      stdio: 'ignore',
    });
  } catch {
    // Container didn't exist — fine
  }

  const envFlags: string[] = [];
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      envFlags.push('-e', `${key}=${value}`);
    }
  }

  const volumeFlags: string[] = [];
  if (options.volumes) {
    for (const v of options.volumes) {
      volumeFlags.push('-v', v);
    }
  }

  const args = [
    '-H', `unix://${sock}`,
    'create',
    '--name', options.containerName,
    '-it',
    '-w', WORKSPACE_DIR,
    '-v', `${options.projectPath}:${WORKSPACE_DIR}`,
    ...volumeFlags,
    '--add-host', 'host.docker.internal:host-gateway',
    '-u', `${CONTAINER_UID}:${CONTAINER_GID}`,
    ...envFlags,
    imageTagFor(options.agentType),
    ...(options.command ? ['-c', options.command] : []),
  ];

  const result = execFileSync('docker', args, {
    encoding: 'utf-8',
    timeout: 30_000,
  });

  return result.trim().slice(0, 12); // short container ID
}

/**
 * Build the `docker start -ai <containerId>` command string
 * that the runtime will execute to attach to the container.
 */
export function buildDockerStartCommand(containerId: string, socketPath?: string): string {
  const sock = socketPath || findDockerSocket();
  if (sock) {
    return `docker -H unix://${sock} start -ai ${containerId}`;
  }
  return `docker start -ai ${containerId}`;
}

/**
 * Check if a container is running.
 */
export function isContainerRunning(containerId: string, socketPath?: string): boolean {
  const sock = socketPath || findDockerSocket();
  if (!sock) return false;

  try {
    const result = execSync(
      `docker -H unix://${sock} inspect -f '{{.State.Running}}' ${containerId}`,
      { encoding: 'utf-8', timeout: 5000 },
    );
    return result.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Check if a container exists (running or stopped).
 */
export function containerExists(containerId: string, socketPath?: string): boolean {
  const sock = socketPath || findDockerSocket();
  if (!sock) return false;

  try {
    execSync(
      `docker -H unix://${sock} inspect ${containerId}`,
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop a container gracefully (10s timeout before SIGKILL).
 */
export function stopContainer(containerId: string, socketPath?: string): boolean {
  const sock = socketPath || findDockerSocket();
  if (!sock) return false;

  try {
    execSync(
      `docker -H unix://${sock} stop -t 10 ${containerId}`,
      { timeout: 15_000, stdio: ['ignore', 'ignore', 'ignore'] },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a container (force remove if still running).
 */
export function removeContainer(containerId: string, socketPath?: string): boolean {
  const sock = socketPath || findDockerSocket();
  if (!sock) return false;

  try {
    execSync(
      `docker -H unix://${sock} rm -f ${containerId}`,
      { timeout: 15_000, stdio: ['ignore', 'ignore', 'ignore'] },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Start a stopped container (non-interactive, background).
 */
export function startContainerBackground(containerId: string, socketPath?: string): boolean {
  const sock = socketPath || findDockerSocket();
  if (!sock) return false;

  try {
    execSync(
      `docker -H unix://${sock} start ${containerId}`,
      { timeout: 10_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a command inside a running container and return stdout.
 */
export function execInContainer(containerId: string, command: string, socketPath?: string): string {
  const sock = socketPath || findDockerSocket();
  if (!sock) throw new Error('Docker socket not found');

  return execSync(
    `docker -H unix://${sock} exec ${containerId} sh -c ${escapeForSh(command)}`,
    { encoding: 'utf-8', timeout: 30_000 },
  ).trim();
}

function escapeForSh(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export { WORKSPACE_DIR };
