/**
 * Codex (OpenAI) agent adapter
 */

import { BaseAgentAdapter, type AgentConfig, type AgentIntegrationMode, type AgentIntegrationResult } from '../base.js';
import { installCodexHook } from './hook-installer.js';

export {
  installCodexHook, removeCodexHook,
  getCodexConfigDir, getCodexHookDir, getCodexConfigPath, getCodexHookSourcePath,
  CODEX_HOOK_FILENAME,
} from './hook-installer.js';

const codexConfig: AgentConfig = {
  name: 'codex',
  displayName: 'Codex',
  command: 'codex',
  channelSuffix: 'codex',
};

export class CodexAdapter extends BaseAgentAdapter {
  constructor() {
    super(codexConfig);
  }

  getStartCommand(projectPath: string, permissionAllow = false): string {
    const flag = permissionAllow ? ' --full-auto' : '';
    return `cd "${projectPath}" && ${this.config.command}${flag}`;
  }

  installIntegration(_projectPath: string, mode: AgentIntegrationMode = 'install'): AgentIntegrationResult {
    const infoMessages: string[] = [];
    const warningMessages: string[] = [];

    try {
      const hookPath = installCodexHook();
      infoMessages.push(
        mode === 'install'
          ? `🔔 Installed Codex hook: ${hookPath}`
          : `Reinstalled Codex hook: ${hookPath}`,
      );
      return { agentType: this.config.name, eventHookInstalled: true, infoMessages, warningMessages };
    } catch (error) {
      warningMessages.push(
        mode === 'install'
          ? `Failed to install Codex hook: ${error instanceof Error ? error.message : String(error)}`
          : `Could not reinstall Codex hook: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { agentType: this.config.name, eventHookInstalled: false, infoMessages, warningMessages };
    }
  }
}

export const codexAdapter = new CodexAdapter();
