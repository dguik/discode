import { describe, expect, it } from 'vitest';
import { buildAgentLaunchEnv, buildExportPrefix } from '../../src/policy/agent-launch.js';
import { OpenCodeAdapter } from '../../src/agents/opencode/index.js';

describe('agent launch policy', () => {
  it('builds shell export prefix with escaping', () => {
    const prefix = buildExportPrefix({
      A: 'alpha',
      B: "it's",
      EMPTY: undefined,
    });

    expect(prefix).toBe("export A='alpha'; export B='it'\\''s'; ");
  });

  it('builds launch env without agent-specific vars', () => {
    const env = buildAgentLaunchEnv({
      projectName: 'my-project',
      port: 18470,
      agentType: 'claude',
      instanceId: 'claude',
    });
    expect(env.AGENT_DISCORD_PROJECT).toBe('my-project');
    expect(env.AGENT_DISCORD_PORT).toBe('18470');
    expect(env.OPENCODE_PERMISSION).toBeUndefined();
  });

  it('opencode adapter provides permission env var via getExtraEnvVars', () => {
    const adapter = new OpenCodeAdapter();

    const without = adapter.getExtraEnvVars({ permissionAllow: false });
    expect(without.OPENCODE_PERMISSION).toBeUndefined();

    const withPerm = adapter.getExtraEnvVars({ permissionAllow: true });
    expect(withPerm.OPENCODE_PERMISSION).toBe('{"*":"allow"}');
  });
});
