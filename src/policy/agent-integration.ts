import { agentRegistry } from '../agents/index.js';
import type { AgentIntegrationMode, AgentIntegrationResult } from '../agents/base.js';

// Re-export types so existing consumers don't break
export type { AgentIntegrationMode, AgentIntegrationResult };

export function installAgentIntegration(
  agentType: string,
  projectPath: string,
  mode: AgentIntegrationMode = 'install',
): AgentIntegrationResult {
  const adapter = agentRegistry.get(agentType);
  if (!adapter) {
    return { agentType, eventHookInstalled: false, infoMessages: [], warningMessages: [] };
  }
  return adapter.installIntegration(projectPath, mode);
}
