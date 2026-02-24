import { describe, expect, it } from 'vitest';
import type { VtScreenState } from '../../src/runtime/vt-types.js';
import * as ops from '../../src/runtime/vt-screen-buffer-ops.js';

function makeState(overrides?: Partial<VtScreenState>): VtScreenState {
  const s: VtScreenState = {
    cols: 10,
    rows: 4,
    scrollback: 100,
    lines: [],
    cursorRow: 0,
    cursorCol: 0,
    savedRow: 0,
    savedCol: 0,
    currentStyle: {},
    usingAltScreen: false,
    scrollTop: 0,
    scrollBottom: 3,
    wrapPending: false,
    originMode: false,
    cursorVisible: true,
    ...overrides,
  };
  // Initialize with one empty line
  if (s.lines.length === 0) {
    s.lines = [ops.makeLine(s, s.cols)];
  }
  return s;
}

describe('vt-screen-buffer-ops', () => {
  describe('makeCell / makeLine', () => {
    it('creates cell with character and current style', () => {
      const s = makeState({ currentStyle: { fg: '#ff0000' } });
      const cell = ops.makeCell(s, 'A');
      expect(cell.ch).toBe('A');
      expect(cell.style.fg).toBe('#ff0000');
    });

    it('creates line of specified length', () => {
      const s = makeState();
      const line = ops.makeLine(s, 5);
      expect(line).toHaveLength(5);
      expect(line[0].ch).toBe(' ');
    });
  });

  describe('absoluteRowFromViewport', () => {
    it('returns local row directly on alt screen', () => {
      const s = makeState({ usingAltScreen: true });
      expect(ops.absoluteRowFromViewport(s, 2)).toBe(2);
    });

    it('offsets by scrollback on main screen', () => {
      const s = makeState();
      // With 1 line and 4 rows, base = max(0, 1-4) = 0
      expect(ops.absoluteRowFromViewport(s, 0)).toBe(0);
    });

    it('offsets correctly with more lines than rows', () => {
      const s = makeState();
      // Add lines so we have 6 total lines, 4 rows → base = 2
      for (let i = 0; i < 5; i++) s.lines.push(ops.makeLine(s, s.cols));
      expect(ops.absoluteRowFromViewport(s, 0)).toBe(2);
      expect(ops.absoluteRowFromViewport(s, 1)).toBe(3);
    });
  });

  describe('ensureCursorRow', () => {
    it('grows lines to reach cursor on main screen', () => {
      const s = makeState();
      s.cursorRow = 3;
      ops.ensureCursorRow(s);
      expect(s.lines.length).toBeGreaterThanOrEqual(4);
    });

    it('limits lines to rows on alt screen', () => {
      const s = makeState({ usingAltScreen: true });
      ops.ensureCursorRow(s);
      expect(s.lines.length).toBe(s.rows);
    });
  });

  describe('clampCursor', () => {
    it('clamps column to valid range', () => {
      const s = makeState();
      s.cursorCol = 100;
      ops.clampCursor(s);
      expect(s.cursorCol).toBe(s.cols - 1);
    });

    it('clamps negative column to 0', () => {
      const s = makeState();
      s.cursorCol = -5;
      ops.clampCursor(s);
      expect(s.cursorCol).toBe(0);
    });

    it('clamps row with origin mode', () => {
      const s = makeState({ originMode: true, scrollTop: 1, scrollBottom: 2 });
      s.cursorRow = 0;
      ops.clampCursor(s);
      expect(s.cursorRow).toBeGreaterThanOrEqual(ops.absoluteRowFromViewport(s, 1));
    });
  });

  describe('clearLine', () => {
    it('mode 2: clears entire line', () => {
      const s = makeState();
      s.lines[0][0].ch = 'X';
      ops.clearLine(s, 2);
      expect(s.lines[0][0].ch).toBe(' ');
    });

    it('mode 1: clears from start to cursor', () => {
      const s = makeState();
      s.lines[0][0].ch = 'A';
      s.lines[0][1].ch = 'B';
      s.lines[0][2].ch = 'C';
      s.cursorCol = 1;
      ops.clearLine(s, 1);
      expect(s.lines[0][0].ch).toBe(' ');
      expect(s.lines[0][1].ch).toBe(' ');
      expect(s.lines[0][2].ch).toBe('C');
    });

    it('mode 0: clears from cursor to end', () => {
      const s = makeState();
      s.lines[0][0].ch = 'A';
      s.lines[0][1].ch = 'B';
      s.cursorCol = 1;
      ops.clearLine(s, 0);
      expect(s.lines[0][0].ch).toBe('A');
      expect(s.lines[0][1].ch).toBe(' ');
    });
  });

  describe('clearDisplay', () => {
    it('mode 2: resets all lines', () => {
      const s = makeState();
      s.lines.push(ops.makeLine(s, s.cols));
      s.lines[0][0].ch = 'X';
      ops.clearDisplay(s, 2);
      expect(s.lines[0][0].ch).toBe(' ');
    });

    it('mode 2 on alt screen: fills to rows', () => {
      const s = makeState({ usingAltScreen: true });
      while (s.lines.length < s.rows) s.lines.push(ops.makeLine(s, s.cols));
      ops.clearDisplay(s, 2);
      expect(s.lines.length).toBe(s.rows);
    });
  });

  describe('insertChars / deleteChars / eraseChars', () => {
    it('insertChars shifts content right', () => {
      const s = makeState();
      s.lines[0][0].ch = 'A';
      s.lines[0][1].ch = 'B';
      s.cursorCol = 0;
      ops.insertChars(s, 1);
      expect(s.lines[0][0].ch).toBe(' ');
      expect(s.lines[0][1].ch).toBe('A');
    });

    it('deleteChars shifts content left', () => {
      const s = makeState();
      s.lines[0][0].ch = 'A';
      s.lines[0][1].ch = 'B';
      s.lines[0][2].ch = 'C';
      s.cursorCol = 0;
      ops.deleteChars(s, 1);
      expect(s.lines[0][0].ch).toBe('B');
      expect(s.lines[0][1].ch).toBe('C');
    });

    it('eraseChars blanks at cursor without shifting', () => {
      const s = makeState();
      s.lines[0][0].ch = 'A';
      s.lines[0][1].ch = 'B';
      s.cursorCol = 0;
      ops.eraseChars(s, 1);
      expect(s.lines[0][0].ch).toBe(' ');
      expect(s.lines[0][1].ch).toBe('B');
    });
  });

  describe('scrollRegionUp / scrollRegionDown', () => {
    it('scrollRegionUp removes top line and adds blank at bottom', () => {
      const s = makeState({ usingAltScreen: true });
      while (s.lines.length < s.rows) s.lines.push(ops.makeLine(s, s.cols));
      s.lines[0][0].ch = 'X';
      ops.scrollRegionUp(s, 0, 3, 1);
      expect(s.lines[0][0].ch).not.toBe('X');
    });

    it('scrollRegionDown removes bottom line and adds blank at top', () => {
      const s = makeState({ usingAltScreen: true });
      while (s.lines.length < s.rows) s.lines.push(ops.makeLine(s, s.cols));
      s.lines[3][0].ch = 'Y';
      ops.scrollRegionDown(s, 0, 3, 1);
      expect(s.lines[0][0].ch).toBe(' ');
    });
  });

  describe('enterAltScreen / leaveAltScreen', () => {
    it('enterAltScreen saves state and creates blank screen', () => {
      const s = makeState();
      s.lines[0][0].ch = 'X';
      s.cursorRow = 0;
      s.cursorCol = 5;
      ops.enterAltScreen(s);
      expect(s.usingAltScreen).toBe(true);
      expect(s.lines.length).toBe(s.rows);
      expect(s.cursorRow).toBe(0);
      expect(s.cursorCol).toBe(0);
      expect(s.savedPrimaryScreen).toBeDefined();
    });

    it('leaveAltScreen restores saved state', () => {
      const s = makeState();
      s.lines[0][0].ch = 'X';
      s.cursorCol = 5;
      ops.enterAltScreen(s);
      ops.leaveAltScreen(s);
      expect(s.usingAltScreen).toBe(false);
      expect(s.lines[0][0].ch).toBe('X');
      expect(s.cursorCol).toBe(5);
      expect(s.savedPrimaryScreen).toBeUndefined();
    });

    it('enterAltScreen is idempotent', () => {
      const s = makeState();
      ops.enterAltScreen(s);
      const saved = s.savedPrimaryScreen;
      ops.enterAltScreen(s); // second call is noop
      expect(s.savedPrimaryScreen).toBe(saved);
    });
  });

  describe('lineFeed', () => {
    it('advances cursor within scroll region', () => {
      const s = makeState({ usingAltScreen: true });
      while (s.lines.length < s.rows) s.lines.push(ops.makeLine(s, s.cols));
      s.cursorRow = 0;
      ops.lineFeed(s);
      expect(s.cursorRow).toBe(1);
    });

    it('scrolls when at bottom of scroll region', () => {
      const s = makeState({ usingAltScreen: true });
      while (s.lines.length < s.rows) s.lines.push(ops.makeLine(s, s.cols));
      s.cursorRow = s.scrollBottom;
      s.lines[0][0].ch = 'X';
      ops.lineFeed(s);
      // Cursor should stay at scrollBottom, first line should have been scrolled
      expect(s.cursorRow).toBe(s.scrollBottom);
    });
  });

  describe('reverseIndex', () => {
    it('moves cursor up within scroll region', () => {
      const s = makeState({ usingAltScreen: true });
      while (s.lines.length < s.rows) s.lines.push(ops.makeLine(s, s.cols));
      s.cursorRow = 2;
      ops.reverseIndex(s);
      expect(s.cursorRow).toBe(1);
    });

    it('scrolls down at top of scroll region', () => {
      const s = makeState({ usingAltScreen: true });
      while (s.lines.length < s.rows) s.lines.push(ops.makeLine(s, s.cols));
      s.cursorRow = 0;
      s.lines[0][0].ch = 'X';
      ops.reverseIndex(s);
      // Should have scrolled down, adding blank at top
      expect(s.lines[0][0].ch).toBe(' ');
    });
  });

  describe('setCursorPosition / setCursorRow', () => {
    it('sets cursor position directly', () => {
      const s = makeState();
      ops.setCursorPosition(s, 2, 5);
      expect(s.cursorRow).toBe(2);
      expect(s.cursorCol).toBe(5);
    });

    it('clamps negative values to 0', () => {
      const s = makeState();
      ops.setCursorPosition(s, -1, -1);
      expect(s.cursorRow).toBe(0);
      expect(s.cursorCol).toBe(0);
    });

    it('setCursorRow offsets with origin mode', () => {
      const s = makeState({ originMode: true, scrollTop: 2 });
      ops.setCursorRow(s, 1);
      expect(s.cursorRow).toBe(ops.absoluteRowFromViewport(s, 2) + 1);
    });
  });

  describe('resetToInitialState', () => {
    it('resets all state fields', () => {
      const s = makeState({ currentStyle: { fg: '#ff0000', bold: true } });
      s.cursorRow = 3;
      s.cursorCol = 5;
      s.originMode = true;
      ops.resetToInitialState(s);
      expect(s.cursorRow).toBe(0);
      expect(s.cursorCol).toBe(0);
      expect(s.currentStyle).toEqual({});
      expect(s.originMode).toBe(false);
      expect(s.cursorVisible).toBe(true);
      expect(s.wrapPending).toBe(false);
    });
  });

  describe('cursorWithinScrollRegion', () => {
    it('returns true when cursor is within region', () => {
      const s = makeState({ usingAltScreen: true });
      while (s.lines.length < s.rows) s.lines.push(ops.makeLine(s, s.cols));
      s.cursorRow = 1;
      expect(ops.cursorWithinScrollRegion(s)).toBe(true);
    });

    it('returns false when cursor is outside region', () => {
      const s = makeState({ usingAltScreen: true, scrollTop: 1, scrollBottom: 2 });
      while (s.lines.length < s.rows) s.lines.push(ops.makeLine(s, s.cols));
      s.cursorRow = 0;
      expect(ops.cursorWithinScrollRegion(s)).toBe(false);
    });
  });

  describe('trimBottomToRows', () => {
    it('does nothing on main screen', () => {
      const s = makeState();
      s.lines.push(ops.makeLine(s, s.cols));
      const len = s.lines.length;
      ops.trimBottomToRows(s);
      expect(s.lines.length).toBe(len);
    });

    it('trims excess lines on alt screen', () => {
      const s = makeState({ usingAltScreen: true });
      for (let i = 0; i < 10; i++) s.lines.push(ops.makeLine(s, s.cols));
      ops.trimBottomToRows(s);
      expect(s.lines.length).toBe(s.rows);
    });

    it('pads missing lines on alt screen', () => {
      const s = makeState({ usingAltScreen: true });
      s.lines = [ops.makeLine(s, s.cols)];
      ops.trimBottomToRows(s);
      expect(s.lines.length).toBe(s.rows);
    });
  });
});
