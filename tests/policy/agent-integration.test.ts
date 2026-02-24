import { describe, expect, it } from 'vitest';
import { BaseAgentAdapter, type AgentIntegrationMode, type AgentIntegrationResult } from '../../src/agents/base.js';
import { installAgentIntegration } from '../../src/policy/agent-integration.js';

describe('agent integration policy (via adapter delegation)', () => {
  it('installAgentIntegration delegates to adapter', () => {
    // Claude adapter is registered in the default registry, just verify it returns a result
    const result = installAgentIntegration('claude', '/tmp/test-project', 'install');

    expect(result.agentType).toBe('claude');
    // The actual plugin install may or may not succeed depending on environment,
    // but the delegation should work
    expect(typeof result.eventHookInstalled).toBe('boolean');
    expect(Array.isArray(result.infoMessages)).toBe(true);
    expect(Array.isArray(result.warningMessages)).toBe(true);
  });

  it('installAgentIntegration returns no-op for unknown agent', () => {
    const result = installAgentIntegration('unknown-agent', '/tmp/test', 'install');

    expect(result.eventHookInstalled).toBe(false);
    expect(result.infoMessages).toHaveLength(0);
    expect(result.warningMessages).toHaveLength(0);
  });

  it('BaseAgentAdapter has default no-op installIntegration', () => {
    // Create a minimal concrete adapter
    class TestAdapter extends BaseAgentAdapter {
      constructor() {
        super({ name: 'test', displayName: 'Test', command: 'test', channelSuffix: 'test' });
      }
    }

    const adapter = new TestAdapter();
    const result = adapter.installIntegration('/tmp/test');

    expect(result.agentType).toBe('test');
    expect(result.eventHookInstalled).toBe(false);
    expect(result.infoMessages).toHaveLength(0);
    expect(result.warningMessages).toHaveLength(0);
  });

  it('BaseAgentAdapter has default no-op injectContainerPlugins', () => {
    class TestAdapter extends BaseAgentAdapter {
      constructor() {
        super({ name: 'test', displayName: 'Test', command: 'test', channelSuffix: 'test' });
      }
    }

    const adapter = new TestAdapter();
    expect(adapter.injectContainerPlugins('container-id')).toBe(false);
  });

  it('BaseAgentAdapter has default no-op buildLaunchCommand', () => {
    class TestAdapter extends BaseAgentAdapter {
      constructor() {
        super({ name: 'test', displayName: 'Test', command: 'test', channelSuffix: 'test' });
      }
    }

    const adapter = new TestAdapter();
    expect(adapter.buildLaunchCommand('test-command')).toBe('test-command');
  });

  it('BaseAgentAdapter has default no-op getExtraEnvVars', () => {
    class TestAdapter extends BaseAgentAdapter {
      constructor() {
        super({ name: 'test', displayName: 'Test', command: 'test', channelSuffix: 'test' });
      }
    }

    const adapter = new TestAdapter();
    expect(adapter.getExtraEnvVars()).toEqual({});
  });
});
