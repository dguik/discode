import { chmodSync, cpSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const CLAUDE_PLUGIN_NAME = 'discode-claude-bridge';
export const CLAUDE_STOP_HOOK_FILENAME = 'discode-stop-hook.js';

export function getClaudePluginDir(): string {
  return join(homedir(), '.claude', 'plugins', CLAUDE_PLUGIN_NAME);
}

export function getPluginSourceDir(): string {
  return join(import.meta.dirname, 'plugin');
}

export function installClaudePlugin(_projectPath?: string, targetDir?: string): string {
  const pluginDir = targetDir ?? getClaudePluginDir();
  const sourceDir = getPluginSourceDir();

  mkdirSync(pluginDir, { recursive: true });
  cpSync(sourceDir, pluginDir, { recursive: true });

  chmodSync(join(pluginDir, 'scripts', CLAUDE_STOP_HOOK_FILENAME), 0o755);

  return pluginDir;
}
