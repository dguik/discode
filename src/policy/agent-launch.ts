import { escapeShellArg } from '../infra/shell-escape.js';

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
}): Record<string, string> {
  return {
    DISCODE_PROJECT: params.projectName,
    DISCODE_PORT: String(params.port),
    DISCODE_AGENT: params.agentType,
    DISCODE_INSTANCE: params.instanceId,
    ...(params.hostname ? { DISCODE_HOSTNAME: params.hostname } : {}),
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
}): Record<string, string> {
  return {
    DISCODE_PROJECT: params.projectName,
    DISCODE_PORT: String(params.port),
    DISCODE_AGENT: params.agentType,
    DISCODE_INSTANCE: params.instanceId,
    // Container→host communication via Docker's built-in DNS
    DISCODE_HOSTNAME: 'host.docker.internal',
  };
}
