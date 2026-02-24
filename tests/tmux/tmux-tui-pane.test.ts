import { describe, expect, it, vi } from 'vitest';
import type { ICommandExecutor } from '../../src/types/interfaces.js';
import {
  findTuiPaneTargets,
  getWindowWidth,
  getTuiPaneWidth,
  resizePaneWidth,
  ensureTuiPane,
} from '../../src/tmux/tmux-tui-pane.js';

function mockExecutor(responses: Record<string, string>): ICommandExecutor {
  const exec = vi.fn((cmd: string) => {
    for (const [pattern, response] of Object.entries(responses)) {
      if (cmd.includes(pattern)) return response;
    }
    return '';
  });
  return { exec, execVoid: vi.fn() };
}

describe('tmux-tui-pane', () => {
  describe('findTuiPaneTargets', () => {
    it('finds pane by title', () => {
      const executor = mockExecutor({
        'list-panes': '0\tbash\t/bin/bash\n1\tdiscode-tui\tdiscode.js tui\n',
      });
      const targets = findTuiPaneTargets(executor, 'sess', 'win');
      expect(targets).toEqual(['sess:win.1']);
    });

    it('finds pane by command marker', () => {
      const executor = mockExecutor({
        'list-panes': '0\tbash\t/bin/bash\n1\tbash\tnode discode.js tui\n',
      });
      const targets = findTuiPaneTargets(executor, 'sess', 'win');
      expect(targets).toEqual(['sess:win.1']);
    });

    it('returns empty when no TUI pane exists', () => {
      const executor = mockExecutor({
        'list-panes': '0\tbash\t/bin/bash\n',
      });
      const targets = findTuiPaneTargets(executor, 'sess', 'win');
      expect(targets).toEqual([]);
    });

    it('prioritizes title match over command match', () => {
      const executor = mockExecutor({
        'list-panes': '0\tbash\tdiscode.js tui\n1\tdiscode-tui\t/bin/bash\n',
      });
      const targets = findTuiPaneTargets(executor, 'sess', 'win');
      // Title match should come first
      expect(targets[0]).toBe('sess:win.1');
    });

    it('deduplicates targets', () => {
      const executor = mockExecutor({
        'list-panes': '1\tdiscode-tui\tdiscode.js tui\n',
      });
      const targets = findTuiPaneTargets(executor, 'sess', 'win');
      expect(targets).toHaveLength(1);
    });

    it('returns empty on executor error', () => {
      const executor: ICommandExecutor = {
        exec: vi.fn(() => { throw new Error('fail'); }),
        execVoid: vi.fn(),
      };
      expect(findTuiPaneTargets(executor, 'sess', 'win')).toEqual([]);
    });
  });

  describe('getWindowWidth', () => {
    it('returns parsed width', () => {
      const executor = mockExecutor({ 'display-message': '120' });
      expect(getWindowWidth(executor, 'sess:win')).toBe(120);
    });

    it('returns undefined on error', () => {
      const executor: ICommandExecutor = {
        exec: vi.fn(() => { throw new Error('fail'); }),
        execVoid: vi.fn(),
      };
      expect(getWindowWidth(executor, 'sess:win')).toBeUndefined();
    });

    it('returns undefined for non-numeric output', () => {
      const executor = mockExecutor({ 'display-message': 'abc' });
      expect(getWindowWidth(executor, 'sess:win')).toBeUndefined();
    });
  });

  describe('getTuiPaneWidth', () => {
    it('returns max width when window width is unknown', () => {
      const executor: ICommandExecutor = {
        exec: vi.fn(() => { throw new Error('fail'); }),
        execVoid: vi.fn(),
      };
      expect(getTuiPaneWidth(executor, 'sess:win')).toBe(80);
    });

    it('caps at half window width', () => {
      const executor = mockExecutor({ 'display-message': '100' });
      // maxByBalance = floor((100-1)/2) = 49
      expect(getTuiPaneWidth(executor, 'sess:win')).toBe(49);
    });

    it('caps at 80 for wide windows', () => {
      const executor = mockExecutor({ 'display-message': '300' });
      expect(getTuiPaneWidth(executor, 'sess:win')).toBe(80);
    });
  });

  describe('resizePaneWidth', () => {
    it('calls tmux resize-pane', () => {
      const executor = mockExecutor({ 'resize-pane': '' });
      resizePaneWidth(executor, 'sess:win.1', 60);
      expect(executor.exec).toHaveBeenCalledWith(expect.stringContaining('resize-pane'));
      expect(executor.exec).toHaveBeenCalledWith(expect.stringContaining('-x 60'));
    });

    it('does not throw on error', () => {
      const executor: ICommandExecutor = {
        exec: vi.fn(() => { throw new Error('fail'); }),
        execVoid: vi.fn(),
      };
      expect(() => resizePaneWidth(executor, 'sess:win.1', 60)).not.toThrow();
    });
  });

  describe('ensureTuiPane', () => {
    it('reuses existing TUI pane and resizes', () => {
      const calls: string[] = [];
      const executor: ICommandExecutor = {
        exec: vi.fn((cmd: string) => {
          calls.push(cmd);
          if (cmd.includes('list-panes')) return '0\tbash\t/bin/bash\n1\tdiscode-tui\tdiscode.js tui\n';
          if (cmd.includes('display-message')) return '200';
          return '';
        }),
        execVoid: vi.fn(),
      };
      ensureTuiPane(executor, 'sess', 'win', 'discode tui');
      // Should NOT have called split-window since TUI pane already exists
      expect(calls.some(c => c.includes('split-window'))).toBe(false);
      // Should have called resize
      expect(calls.some(c => c.includes('resize-pane'))).toBe(true);
    });

    it('creates new TUI pane when none exists', () => {
      const calls: string[] = [];
      const executor: ICommandExecutor = {
        exec: vi.fn((cmd: string) => {
          calls.push(cmd);
          if (cmd.includes('list-panes')) return '0\tbash\t/bin/bash\n';
          if (cmd.includes('display-message')) return '200';
          if (cmd.includes('split-window')) return '1';
          return '';
        }),
        execVoid: vi.fn(),
      };
      ensureTuiPane(executor, 'sess', 'win', 'discode tui');
      expect(calls.some(c => c.includes('split-window'))).toBe(true);
      expect(calls.some(c => c.includes('select-pane'))).toBe(true);
    });

    it('accepts array command format', () => {
      const calls: string[] = [];
      const executor: ICommandExecutor = {
        exec: vi.fn((cmd: string) => {
          calls.push(cmd);
          if (cmd.includes('list-panes')) return '0\tbash\t/bin/bash\n';
          if (cmd.includes('display-message')) return '200';
          if (cmd.includes('split-window')) return '1';
          return '';
        }),
        execVoid: vi.fn(),
      };
      ensureTuiPane(executor, 'sess', 'win', ['node', 'discode.js', 'tui']);
      const splitCmd = calls.find(c => c.includes('split-window'));
      expect(splitCmd).toBeDefined();
    });

    it('kills duplicate TUI panes', () => {
      const calls: string[] = [];
      const executor: ICommandExecutor = {
        exec: vi.fn((cmd: string) => {
          calls.push(cmd);
          if (cmd.includes('list-panes')) return '0\tdiscode-tui\tdiscode.js tui\n1\tdiscode-tui\tdiscode.js tui\n';
          if (cmd.includes('display-message')) return '200';
          return '';
        }),
        execVoid: vi.fn(),
      };
      ensureTuiPane(executor, 'sess', 'win', 'discode tui');
      expect(calls.some(c => c.includes('kill-pane'))).toBe(true);
    });
  });
});
