/**
 * Claude Code agent adapter
 */

import { BaseAgentAdapter, type AgentConfig } from './base.js';

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
}

export const claudeAdapter = new ClaudeAdapter();
