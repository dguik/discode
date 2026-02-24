/**
 * Base agent adapter interface
 * All AI agent CLIs must implement this interface
 */

import type { ICommandExecutor } from '../types/interfaces.js';
import { ShellCommandExecutor } from '../infra/shell.js';

export interface AgentConfig {
  name: string;
  displayName: string;
  command: string;
  channelSuffix: string;
}

export type AgentIntegrationMode = 'install' | 'reinstall';

export type AgentIntegrationResult = {
  agentType: string;
  eventHookInstalled: boolean;
  claudePluginDir?: string;
  infoMessages: string[];
  warningMessages: string[];
};

export abstract class BaseAgentAdapter {
  readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  /**
   * Check if the agent CLI is installed on this system
   */
  isInstalled(executor?: ICommandExecutor): boolean {
    const exec = executor || new ShellCommandExecutor();
    try {
      exec.execVoid(`command -v ${this.config.command}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the command to start this agent in a directory
   */
  getStartCommand(projectPath: string, _permissionAllow = false): string {
    return `cd "${projectPath}" && ${this.config.command}`;
  }

  /**
   * Parse channel name to check if it belongs to this agent
   */
  matchesChannel(channelName: string, projectName: string): boolean {
    return channelName === `${projectName}-${this.config.channelSuffix}`;
  }

  /**
   * Install agent-specific integration (plugins, hooks) into a project directory.
   * Default: no-op.
   */
  installIntegration(_projectPath: string, _mode: AgentIntegrationMode = 'install'): AgentIntegrationResult {
    return {
      agentType: this.config.name,
      eventHookInstalled: false,
      infoMessages: [],
      warningMessages: [],
    };
  }

  /**
   * Inject agent-specific plugins/hooks into an existing container.
   * Default: no-op (returns false).
   */
  injectContainerPlugins(_containerId: string, _socketPath?: string): boolean {
    return false;
  }

  /**
   * Wrap or modify the launch command with agent-specific flags (e.g. --plugin-dir).
   * Default: returns command unchanged.
   */
  buildLaunchCommand(command: string, _integrationResult?: AgentIntegrationResult): string {
    return command;
  }

  /**
   * Return extra environment variables needed for this agent type.
   * Default: empty object.
   */
  getExtraEnvVars(_options?: { permissionAllow?: boolean }): Record<string, string> {
    return {};
  }
}

export type AgentType = 'claude' | 'gemini' | 'opencode' | string;

/**
 * Registry for all available agent adapters
 */
export class AgentRegistry {
  private adapters: Map<AgentType, BaseAgentAdapter> = new Map();

  register(adapter: BaseAgentAdapter): void {
    this.adapters.set(adapter.config.name, adapter);
  }

  get(name: AgentType): BaseAgentAdapter | undefined {
    return this.adapters.get(name);
  }

  getAll(): BaseAgentAdapter[] {
    return Array.from(this.adapters.values());
  }

  getByChannelSuffix(suffix: string): BaseAgentAdapter | undefined {
    return this.getAll().find(a => a.config.channelSuffix === suffix);
  }

  parseChannelName(channelName: string): { projectName: string; agent: BaseAgentAdapter } | null {
    for (const adapter of this.getAll()) {
      const suffix = `-${adapter.config.channelSuffix}`;
      if (channelName.endsWith(suffix)) {
        return {
          projectName: channelName.slice(0, -suffix.length),
          agent: adapter,
        };
      }
    }
    return null;
  }
}
