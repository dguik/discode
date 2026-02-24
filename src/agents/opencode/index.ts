/**
 * OpenCode CLI agent adapter
 * https://opencode.ai/
 */

import { BaseAgentAdapter, type AgentConfig, type AgentIntegrationMode, type AgentIntegrationResult } from '../base.js';
import { installOpencodePlugin, getPluginSourcePath } from './plugin-installer.js';
import { injectFile } from '../../container/index.js';

export { installOpencodePlugin, getPluginSourcePath, getOpencodePluginDir, OPENCODE_PLUGIN_FILENAME } from './plugin-installer.js';

const opencodeConfig: AgentConfig = {
  name: 'opencode',
  displayName: 'OpenCode',
  command: 'opencode',
  channelSuffix: 'opencode',
};

export class OpenCodeAdapter extends BaseAgentAdapter {
  constructor() {
    super(opencodeConfig);
  }

  installIntegration(_projectPath: string, mode: AgentIntegrationMode = 'install'): AgentIntegrationResult {
    const infoMessages: string[] = [];
    const warningMessages: string[] = [];

    try {
      const pluginPath = installOpencodePlugin();
      infoMessages.push(
        mode === 'install'
          ? `🧩 Installed OpenCode plugin: ${pluginPath}`
          : `Reinstalled OpenCode plugin: ${pluginPath}`,
      );
      return { agentType: this.config.name, eventHookInstalled: true, infoMessages, warningMessages };
    } catch (error) {
      warningMessages.push(
        mode === 'install'
          ? `Failed to install OpenCode plugin: ${error instanceof Error ? error.message : String(error)}`
          : `Could not reinstall OpenCode plugin: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { agentType: this.config.name, eventHookInstalled: false, infoMessages, warningMessages };
    }
  }

  injectContainerPlugins(containerId: string, socketPath?: string): boolean {
    const pluginSource = getPluginSourcePath();
    if (injectFile(containerId, pluginSource, '/home/coder/.opencode/plugins', socketPath)) {
      console.log(`🧩 Injected OpenCode plugin into container ${containerId.slice(0, 12)}`);
      return true;
    }
    return false;
  }

  getExtraEnvVars(options?: { permissionAllow?: boolean }): Record<string, string> {
    if (options?.permissionAllow) {
      return { OPENCODE_PERMISSION: '{"*":"allow"}' };
    }
    return {};
  }
}

export const opencodeAdapter = new OpenCodeAdapter();
