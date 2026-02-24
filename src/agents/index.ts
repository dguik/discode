/**
 * Agent adapters registry
 */

export * from './base.js';
export { claudeAdapter, ClaudeAdapter } from './claude/index.js';
export { geminiAdapter, GeminiAdapter } from './gemini/index.js';
export { opencodeAdapter, OpenCodeAdapter } from './opencode/index.js';
export { codexAdapter, CodexAdapter } from './codex/index.js';

import { AgentRegistry } from './base.js';
import { claudeAdapter } from './claude/index.js';
import { geminiAdapter } from './gemini/index.js';
import { opencodeAdapter } from './opencode/index.js';
import { codexAdapter } from './codex/index.js';

/**
 * Create a new AgentRegistry with all default adapters registered
 */
export function createAgentRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register(claudeAdapter);
  registry.register(geminiAdapter);
  registry.register(opencodeAdapter);
  registry.register(codexAdapter);
  return registry;
}

// Default singleton for backward compatibility
export const agentRegistry = createAgentRegistry();
