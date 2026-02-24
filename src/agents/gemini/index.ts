/**
 * Gemini CLI agent adapter
 */

import { BaseAgentAdapter, type AgentConfig, type AgentIntegrationMode, type AgentIntegrationResult } from '../base.js';
import { installGeminiHook, getGeminiHookSourcePath, GEMINI_AFTER_AGENT_HOOK_FILENAME, GEMINI_NOTIFICATION_HOOK_FILENAME, GEMINI_SESSION_HOOK_FILENAME } from './hook-installer.js';
import { injectFile } from '../../container/index.js';

export {
  installGeminiHook, removeGeminiHook,
  getGeminiHookSourcePath, getGeminiConfigDir, getGeminiHookDir, getGeminiSettingsPath,
  GEMINI_HOOK_NAME, GEMINI_AFTER_AGENT_HOOK_FILENAME, GEMINI_NOTIFICATION_HOOK_FILENAME,
  GEMINI_SESSION_HOOK_FILENAME, GEMINI_NOTIFICATION_HOOK_NAME, GEMINI_SESSION_HOOK_NAME,
} from './hook-installer.js';

const geminiConfig: AgentConfig = {
  name: 'gemini',
  displayName: 'Gemini CLI',
  command: 'gemini',
  channelSuffix: 'gemini',
};

export class GeminiAdapter extends BaseAgentAdapter {
  constructor() {
    super(geminiConfig);
  }

  installIntegration(_projectPath: string, mode: AgentIntegrationMode = 'install'): AgentIntegrationResult {
    const infoMessages: string[] = [];
    const warningMessages: string[] = [];

    try {
      const hookPath = installGeminiHook();
      infoMessages.push(
        mode === 'install'
          ? `🪝 Installed Gemini CLI hook: ${hookPath}`
          : `Reinstalled Gemini CLI hook: ${hookPath}`,
      );
      return { agentType: this.config.name, eventHookInstalled: true, infoMessages, warningMessages };
    } catch (error) {
      warningMessages.push(
        mode === 'install'
          ? `Failed to install Gemini CLI hook: ${error instanceof Error ? error.message : String(error)}`
          : `Could not reinstall Gemini CLI hook: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { agentType: this.config.name, eventHookInstalled: false, infoMessages, warningMessages };
    }
  }

  injectContainerPlugins(containerId: string, socketPath?: string): boolean {
    const geminiHooksDir = '/home/coder/.gemini/discode-hooks';
    for (const hookFile of [GEMINI_AFTER_AGENT_HOOK_FILENAME, GEMINI_NOTIFICATION_HOOK_FILENAME, GEMINI_SESSION_HOOK_FILENAME]) {
      injectFile(containerId, getGeminiHookSourcePath(hookFile), geminiHooksDir, socketPath);
    }
    console.log(`🪝 Injected Gemini hooks into container ${containerId.slice(0, 12)}`);
    return true;
  }
}

export const geminiAdapter = new GeminiAdapter();
