/**
 * Tests for ClaudeAdapter installIntegration and buildLaunchCommand
 */

import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../../src/agents/claude/index.js';

describe('ClaudeAdapter', () => {
  describe('installIntegration', () => {
    it('returns integration result with correct agentType', () => {
      const adapter = new ClaudeAdapter();
      const result = adapter.installIntegration('/tmp/test');
      expect(result.agentType).toBe('claude');
    });

    it('returns claudePluginDir on success', () => {
      const adapter = new ClaudeAdapter();
      const result = adapter.installIntegration('/tmp/test');
      // May succeed or fail depending on env, but should return proper structure
      expect(typeof result.eventHookInstalled).toBe('boolean');
      if (result.eventHookInstalled) {
        expect(result.claudePluginDir).toBeDefined();
        expect(typeof result.claudePluginDir).toBe('string');
      }
    });
  });

  describe('buildLaunchCommand', () => {
    it('adds --plugin-dir when claudePluginDir is set', () => {
      const adapter = new ClaudeAdapter();
      const result = adapter.buildLaunchCommand(
        'cd "/project" && claude',
        { agentType: 'claude', eventHookInstalled: true, claudePluginDir: '/my/plugin', infoMessages: [], warningMessages: [] },
      );
      expect(result).toContain('--plugin-dir');
      expect(result).toContain('/my/plugin');
    });

    it('does not modify command when no pluginDir', () => {
      const adapter = new ClaudeAdapter();
      const result = adapter.buildLaunchCommand(
        'cd "/project" && claude',
        { agentType: 'claude', eventHookInstalled: false, infoMessages: [], warningMessages: [] },
      );
      expect(result).toBe('cd "/project" && claude');
    });

    it('does not add --plugin-dir if already present', () => {
      const adapter = new ClaudeAdapter();
      const result = adapter.buildLaunchCommand(
        'cd "/project" && claude --plugin-dir /existing',
        { agentType: 'claude', eventHookInstalled: true, claudePluginDir: '/new/plugin', infoMessages: [], warningMessages: [] },
      );
      expect(result).toBe('cd "/project" && claude --plugin-dir /existing');
    });

    it('returns command unchanged for non-claude commands', () => {
      const adapter = new ClaudeAdapter();
      const result = adapter.buildLaunchCommand(
        'cd "/project" && opencode',
        { agentType: 'claude', eventHookInstalled: true, claudePluginDir: '/my/plugin', infoMessages: [], warningMessages: [] },
      );
      expect(result).toBe('cd "/project" && opencode');
    });
  });
});
