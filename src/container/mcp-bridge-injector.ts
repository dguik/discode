/**
 * Chrome MCP bridge injection into containers.
 *
 * Copies chrome-mcp-bridge.cjs into the container and merges
 * agent-specific MCP config entries for Claude, Gemini, and OpenCode.
 */

import { randomBytes, createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir, tmpdir } from 'os';
import { findDockerSocket } from './docker-socket.js';
import { assertValidContainerId } from './manager.js';

const BRIDGE_SCRIPT_FILENAME = 'chrome-mcp-bridge.cjs';

/**
 * Resolve the host-side path to the chrome-mcp-bridge.cjs script.
 * Uses the same candidate-search pattern as the plugin installers.
 */
export function resolveBridgeScriptPath(): string | null {
  const execDir = dirname(process.execPath);
  const candidates = [
    join(import.meta.dirname, BRIDGE_SCRIPT_FILENAME),                     // source layout: src/container/
    join(import.meta.dirname, 'container', BRIDGE_SCRIPT_FILENAME),        // bundled chunk in dist/
    join(import.meta.dirname, '../container', BRIDGE_SCRIPT_FILENAME),     // bundled entry in dist/src/
    join(execDir, '..', 'resources', BRIDGE_SCRIPT_FILENAME),              // compiled binary
  ];
  return candidates.find(p => existsSync(p)) ?? null;
}

/**
 * Verify the bridge script's SHA-256 checksum against the sidecar `.sha256` file.
 * Returns true if the hash matches or no sidecar exists (graceful degradation).
 * Returns false if the sidecar exists but the hash does not match.
 */
export function verifyBridgeScriptIntegrity(scriptPath: string): boolean {
  const sidecarPath = scriptPath + '.sha256';
  if (!existsSync(sidecarPath)) {
    // No sidecar — skip verification (development or source layout)
    return true;
  }
  try {
    const expectedHash = readFileSync(sidecarPath, 'utf-8').trim();
    const scriptContent = readFileSync(scriptPath);
    const actualHash = createHash('sha256').update(scriptContent).digest('hex');
    return actualHash === expectedHash;
  } catch {
    // If we can't read files, fail open with a warning
    console.warn('Chrome MCP bridge integrity check: could not read script or sidecar');
    return true;
  }
}

/**
 * Agent-specific config paths and MCP config builders.
 */
export interface AgentMcpConfig {
  /** Host-side config file to read as a base. */
  hostConfigPath: string;
  /** Container path to write the merged config. */
  containerConfigPath: string;
  /** Merge the chrome-in-chrome MCP entry into the config object. */
  merge(config: Record<string, any>, port: number): void;
}

export function getAgentMcpConfig(agentType: string): AgentMcpConfig | null {
  switch (agentType) {
    case 'claude':
      return {
        hostConfigPath: join(homedir(), '.claude.json'),
        containerConfigPath: '/home/coder/.claude.json',
        merge(config, port) {
          if (!config.mcpServers) config.mcpServers = {};
          config.mcpServers['claude-in-chrome'] = {
            type: 'stdio',
            command: 'node',
            args: [`/tmp/${BRIDGE_SCRIPT_FILENAME}`],
            env: { CHROME_MCP_HOST: 'host.docker.internal', CHROME_MCP_PORT: String(port) },
          };
        },
      };
    case 'gemini':
      return {
        hostConfigPath: join(homedir(), '.gemini', 'settings.json'),
        containerConfigPath: '/home/coder/.gemini/settings.json',
        merge(config, port) {
          if (!config.mcpServers) config.mcpServers = {};
          config.mcpServers['claude-in-chrome'] = {
            command: 'node',
            args: [`/tmp/${BRIDGE_SCRIPT_FILENAME}`],
            env: { CHROME_MCP_HOST: 'host.docker.internal', CHROME_MCP_PORT: String(port) },
          };
        },
      };
    case 'opencode':
      return {
        hostConfigPath: join(homedir(), '.config', 'opencode', 'opencode.json'),
        containerConfigPath: '/home/coder/.config/opencode/opencode.json',
        merge(config, port) {
          if (!config.mcp) config.mcp = {};
          config.mcp['claude-in-chrome'] = {
            type: 'local',
            command: ['node', `/tmp/${BRIDGE_SCRIPT_FILENAME}`],
            environment: { CHROME_MCP_HOST: 'host.docker.internal', CHROME_MCP_PORT: String(port) },
          };
        },
      };
    default:
      return null;
  }
}

/**
 * Inject the Chrome MCP bridge into a container.
 *
 * 1. Copies chrome-mcp-bridge.cjs to /tmp/ inside the container
 * 2. Reads the host-side agent config, adds the chrome MCP server entry,
 *    and writes the merged config into the container.
 *
 * Must be called AFTER injectCredentials() so base configs exist.
 */
export function injectChromeMcpBridge(
  containerId: string,
  proxyPort: number,
  agentType: string,
  socketPath?: string,
): boolean {
  assertValidContainerId(containerId);
  const sock = socketPath || findDockerSocket();
  if (!sock) return false;

  const bridgeScriptPath = resolveBridgeScriptPath();
  if (!bridgeScriptPath) {
    console.warn('Chrome MCP bridge script not found; skipping injection');
    return false;
  }

  if (!verifyBridgeScriptIntegrity(bridgeScriptPath)) {
    console.warn('Chrome MCP bridge script integrity check failed: SHA-256 mismatch; skipping injection');
    return false;
  }

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

  try {
    // 1. Copy bridge script into container
    execFileSync('docker', ['-H', `unix://${sock}`, 'cp', bridgeScriptPath, `${containerId}:/tmp/${BRIDGE_SCRIPT_FILENAME}`], {
      timeout: 10_000,
    });

    // 2. Build and inject agent-specific MCP config
    const mcpConfig = getAgentMcpConfig(agentType);
    if (mcpConfig) {
      let config: Record<string, any> = {};
      if (existsSync(mcpConfig.hostConfigPath)) {
        try {
          config = JSON.parse(readFileSync(mcpConfig.hostConfigPath, 'utf-8'));
        } catch {
          // Malformed JSON — start fresh
        }
      }

      mcpConfig.merge(config, proxyPort);

      copyToContainer(
        JSON.stringify(config, null, 2),
        mcpConfig.containerConfigPath,
      );
    }

    return true;
  } catch (error) {
    console.warn(
      `Failed to inject Chrome MCP bridge: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
