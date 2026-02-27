import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { escapeShellArg } from '../infra/shell-escape.js';

/**
 * Read the hook auth token from the well-known state directory.
 * Returns undefined if the token file does not exist.
 */
export function readHookToken(): string | undefined {
  try {
    return readFileSync(join(homedir(), '.discode', '.hook-token'), 'utf-8').trim();
  } catch {
    return undefined;
  }
}

export function buildExportPrefix(env: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    parts.push(`export ${key}=${escapeShellArg(value)}`);
  }
  return parts.length > 0 ? parts.join('; ') + '; ' : '';
}


export function buildAgentLaunchEnv(params: {
  projectName: string;
  port: number;
  agentType: string;
  instanceId: string;
  /** Override hostname for container→host communication. */
  hostname?: string;
  /** Bearer token for hook server authentication. */
  hookToken?: string;
}): Record<string, string> {
  return {
    DISCODE_PROJECT: params.projectName,
    DISCODE_PORT: String(params.port),
    DISCODE_AGENT: params.agentType,
    DISCODE_INSTANCE: params.instanceId,
    ...(params.hostname ? { DISCODE_HOSTNAME: params.hostname } : {}),
    ...(params.hookToken ? { DISCODE_HOOK_TOKEN: params.hookToken } : {}),
  };
}

/**
 * Build environment variables map for a container-based agent session.
 *
 * These are passed as `-e` flags to `docker create` (not shell exports),
 * so they don't need shell escaping.
 */
export function buildContainerEnv(params: {
  projectName: string;
  port: number;
  agentType: string;
  instanceId: string;
  /** Bearer token for hook server authentication. */
  hookToken?: string;
}): Record<string, string> {
  return {
    DISCODE_PROJECT: params.projectName,
    DISCODE_PORT: String(params.port),
    DISCODE_AGENT: params.agentType,
    DISCODE_INSTANCE: params.instanceId,
    // Container→host communication via Docker's built-in DNS
    DISCODE_HOSTNAME: 'host.docker.internal',
    ...(params.hookToken ? { DISCODE_HOOK_TOKEN: params.hookToken } : {}),
  };
}
