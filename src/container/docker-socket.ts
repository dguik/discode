/**
 * Docker socket discovery and availability checks.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';

/**
 * Docker socket search order:
 * OrbStack -> Docker Desktop -> Colima -> Lima -> /var/run/docker.sock
 */
export const DOCKER_SOCKET_CANDIDATES = [
  `${homedir()}/.orbstack/run/docker.sock`,
  `${homedir()}/.docker/run/docker.sock`,
  `${homedir()}/.colima/default/docker.sock`,
  `${homedir()}/.lima/default/sock/docker.sock`,
  '/var/run/docker.sock',
];

/**
 * Find a working Docker socket path.
 */
export function findDockerSocket(): string | null {
  for (const candidate of DOCKER_SOCKET_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Check if Docker is available and responsive.
 */
export function isDockerAvailable(socketPath?: string): boolean {
  const sock = socketPath || findDockerSocket();
  if (!sock) return false;
  try {
    execSync(`docker -H unix://${sock} info`, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
