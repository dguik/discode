import { describe, expect, it, vi } from 'vitest';
import type { ICommandExecutor } from '../../src/types/interfaces.js';
import {
  TUI_PANE_TITLE,
  AGENT_PANE_MARKERS,
  listPaneMetadata,
  resolveAgentPaneHint,
  matchesAgentPane,
  resolveWindowTarget,
} from '../../src/tmux/tmux-pane-resolver.js';

function mockExecutor(responses: Record<string, string>): ICommandExecutor {
  return {
    exec: vi.fn((cmd: string) => {
      for (const [pattern, response] of Object.entries(responses)) {
        if (cmd.includes(pattern)) return response;
      }
      throw new Error(`Unmatched command: ${cmd}`);
    }),
    execVoid: vi.fn(),
  };
}

describe('tmux-pane-resolver', () => {
  describe('resolveAgentPaneHint', () => {
    it('returns opencode for opencode hint', () => {
      expect(resolveAgentPaneHint('opencode')).toBe('opencode');
    });

    it('returns claude for claude hint', () => {
      expect(resolveAgentPaneHint('claude')).toBe('claude');
    });

    it('returns gemini for gemini hint', () => {
      expect(resolveAgentPaneHint('gemini')).toBe('gemini');
    });

    it('is case insensitive', () => {
      expect(resolveAgentPaneHint('CLAUDE')).toBe('claude');
      expect(resolveAgentPaneHint('OpenCode')).toBe('opencode');
    });

    it('returns null for empty string', () => {
      expect(resolveAgentPaneHint('')).toBeNull();
    });

    it('returns null for unknown agent', () => {
      expect(resolveAgentPaneHint('unknown-agent')).toBeNull();
    });

    it('matches agent name within larger string', () => {
      expect(resolveAgentPaneHint('my-claude-window')).toBe('claude');
    });
  });

  describe('matchesAgentPane', () => {
    it('matches pane by title', () => {
      const pane = { index: 0, title: 'claude', startCommand: '/bin/bash' };
      expect(matchesAgentPane(pane, 'claude')).toBe(true);
    });

    it('matches pane by start command', () => {
      const pane = { index: 0, title: '', startCommand: 'claude --dangerously-skip-permissions' };
      expect(matchesAgentPane(pane, 'claude')).toBe(true);
    });

    it('rejects TUI pane even if agent marker is present', () => {
      const pane = { index: 0, title: TUI_PANE_TITLE, startCommand: 'claude' };
      expect(matchesAgentPane(pane, 'claude')).toBe(false);
    });

    it('rejects non-matching pane', () => {
      const pane = { index: 0, title: 'bash', startCommand: '/bin/bash' };
      expect(matchesAgentPane(pane, 'claude')).toBe(false);
    });
  });

  describe('listPaneMetadata', () => {
    it('parses pane list output', () => {
      const executor = mockExecutor({
        'list-panes': '0\tbash\t/bin/bash\n1\tclaude\tclaude --chat\n',
      });
      const panes = listPaneMetadata(executor, 'sess', 'win');
      expect(panes).toHaveLength(2);
      expect(panes[0]).toEqual({ index: 0, title: 'bash', startCommand: '/bin/bash' });
      expect(panes[1]).toEqual({ index: 1, title: 'claude', startCommand: 'claude --chat' });
    });

    it('filters out non-numeric pane indexes', () => {
      const executor = mockExecutor({
        'list-panes': 'abc\tbash\t/bin/bash\n',
      });
      const panes = listPaneMetadata(executor, 'sess', 'win');
      expect(panes).toHaveLength(0);
    });

    it('handles empty output', () => {
      const executor = mockExecutor({ 'list-panes': '\n' });
      const panes = listPaneMetadata(executor, 'sess', 'win');
      expect(panes).toHaveLength(0);
    });
  });

  describe('resolveWindowTarget', () => {
    it('returns explicit pane target without resolution', () => {
      const executor = mockExecutor({});
      const result = resolveWindowTarget(executor, 'sess', 'win.1');
      expect(result).toBe('sess:win.1');
    });

    it('resolves to agent-hinted pane when available', () => {
      const executor = mockExecutor({
        'list-panes': '0\tdiscode-tui\tdiscode.js tui\n1\tclaude\tclaude --chat\n',
      });
      const result = resolveWindowTarget(executor, 'sess', 'win', 'claude');
      expect(result).toBe('sess:win.1');
    });

    it('skips TUI pane and resolves to first non-TUI pane', () => {
      const executor = mockExecutor({
        'list-panes': '0\tdiscode-tui\tdiscode.js tui\n1\tbash\t/bin/bash\n',
      });
      const result = resolveWindowTarget(executor, 'sess', 'win');
      expect(result).toBe('sess:win.1');
    });

    it('falls back to first pane when all are TUI', () => {
      const executor = mockExecutor({
        'list-panes': '0\tdiscode-tui\tdiscode.js tui\n',
      });
      const result = resolveWindowTarget(executor, 'sess', 'win');
      expect(result).toBe('sess:win.0');
    });

    it('falls back to plain target on error', () => {
      const executor = mockExecutor({});
      // list-panes will throw (no matching pattern)
      // but we still handle it: the exec throws which is caught internally
      const failExecutor: ICommandExecutor = {
        exec: vi.fn(() => { throw new Error('fail'); }),
        execVoid: vi.fn(),
      };
      const result = resolveWindowTarget(failExecutor, 'sess', 'win');
      expect(result).toBe('sess:win');
    });
  });

  describe('constants', () => {
    it('TUI_PANE_TITLE is discode-tui', () => {
      expect(TUI_PANE_TITLE).toBe('discode-tui');
    });

    it('AGENT_PANE_MARKERS has entries for all agent types', () => {
      expect(AGENT_PANE_MARKERS.opencode).toContain('opencode');
      expect(AGENT_PANE_MARKERS.claude).toContain('claude');
      expect(AGENT_PANE_MARKERS.gemini).toContain('gemini');
    });
  });
});
