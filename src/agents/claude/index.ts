/**
 * Claude Code agent adapter
 */

import { BaseAgentAdapter, type AgentConfig, type AgentIntegrationMode, type AgentIntegrationResult } from '../base.js';
import { installClaudePlugin } from './plugin-installer.js';
import { escapeShellArg } from '../../infra/shell-escape.js';

const claudeConfig: AgentConfig = {
  name: 'claude',
  displayName: 'Claude Code',
  command: 'claude',
  channelSuffix: 'claude',
};

export class ClaudeAdapter extends BaseAgentAdapter {
  constructor() {
    super(claudeConfig);
  }

  getStartCommand(projectPath: string, permissionAllow = false): string {
    const flag = permissionAllow ? ' --dangerously-skip-permissions' : '';
    return `cd "${projectPath}" && ${this.config.command}${flag}`;
  }

  installIntegration(_projectPath: string, mode: AgentIntegrationMode = 'install'): AgentIntegrationResult {
    const infoMessages: string[] = [];
    const warningMessages: string[] = [];

    try {
      const pluginPath = installClaudePlugin();
      infoMessages.push(
        mode === 'install'
          ? `🪝 Installed Claude Code plugin: ${pluginPath}`
          : `Reinstalled Claude Code plugin: ${pluginPath}`,
      );
      return {
        agentType: this.config.name,
        eventHookInstalled: true,
        claudePluginDir: pluginPath,
        infoMessages,
        warningMessages,
      };
    } catch (error) {
      warningMessages.push(
        mode === 'install'
          ? `Failed to install Claude Code plugin: ${error instanceof Error ? error.message : String(error)}`
          : `Could not reinstall Claude Code plugin: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        agentType: this.config.name,
        eventHookInstalled: false,
        infoMessages,
        warningMessages,
      };
    }
  }

  buildLaunchCommand(command: string, integrationResult?: AgentIntegrationResult): string {
    const pluginDir = integrationResult?.claudePluginDir;
    if (!pluginDir || pluginDir.length === 0) return command;
    if (/--plugin-dir\b/.test(command)) return command;
    const pattern = /((?:^|&&|;)\s*)claude\b/;
    if (!pattern.test(command)) return command;
    return command.replace(pattern, `$1claude --plugin-dir ${escapeShellArg(pluginDir)}`);
  }
}

export const claudeAdapter = new ClaudeAdapter();

// Re-export plugin installer utilities for external consumers
export { installClaudePlugin, getClaudePluginDir, getPluginSourceDir } from './plugin-installer.js';
