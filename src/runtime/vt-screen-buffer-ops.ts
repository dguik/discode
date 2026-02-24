/**
 * VtScreen buffer operations using state-bag pattern.
 *
 * All functions take a mutable VtScreenState as the first argument
 * and modify it in place. This keeps the VtScreen class thin while
 * allowing the buffer logic to be tested and maintained independently.
 */

import type { Cell, VtScreenState } from './vt-types.js';
import { cloneLines } from './vt-utils.js';

export function makeCell(s: VtScreenState, ch: string): Cell {
  return { ch, style: { ...s.currentStyle } };
}

export function makeLine(s: VtScreenState, cols: number): Cell[] {
  return Array.from({ length: cols }, () => makeCell(s, ' '));
}

export function absoluteRowFromViewport(s: VtScreenState, localRow: number): number {
  if (s.usingAltScreen) return localRow;
  const base = Math.max(0, s.lines.length - s.rows);
  return base + localRow;
}

export function ensureCursorRow(s: VtScreenState): void {
  if (s.usingAltScreen) {
    while (s.lines.length < s.rows) {
      s.lines.push(makeLine(s, s.cols));
    }
    while (s.cursorRow >= s.rows) {
      s.cursorRow = s.rows - 1;
      scrollRegionUp(s, s.scrollTop, s.scrollBottom, 1);
    }
    s.cursorRow = Math.max(0, s.cursorRow);
    return;
  }

  while (s.lines.length <= s.cursorRow) {
    s.lines.push(makeLine(s, s.cols));
    if (s.lines.length > s.scrollback) {
      s.lines.shift();
      s.cursorRow = Math.max(0, s.cursorRow - 1);
      s.savedRow = Math.max(0, s.savedRow - 1);
    }
  }
}

export function clampCursor(s: VtScreenState): void {
  const minRow = s.originMode ? absoluteRowFromViewport(s, s.scrollTop) : 0;
  const maxRow = s.originMode ? absoluteRowFromViewport(s, s.scrollBottom) : Number.MAX_SAFE_INTEGER;
  s.cursorRow = Math.max(minRow, Math.min(maxRow, s.cursorRow));
  s.cursorCol = Math.max(0, Math.min(s.cols - 1, s.cursorCol));
}

export function clearLine(s: VtScreenState, mode: number): void {
  ensureCursorRow(s);
  const line = s.lines[s.cursorRow];

  if (mode === 2) {
    s.lines[s.cursorRow] = makeLine(s, s.cols);
    return;
  }
  if (mode === 1) {
    for (let c = 0; c <= s.cursorCol; c += 1) {
      line[c] = makeCell(s, ' ');
    }
    return;
  }
  for (let c = s.cursorCol; c < s.cols; c += 1) {
    line[c] = makeCell(s, ' ');
  }
}

export function clearDisplay(s: VtScreenState, mode: number): void {
  ensureCursorRow(s);
  if (mode === 2) {
    s.lines = [makeLine(s, s.cols)];
    if (s.usingAltScreen) {
      while (s.lines.length < s.rows) s.lines.push(makeLine(s, s.cols));
    }
    return;
  }

  if (mode === 1) {
    for (let r = 0; r < s.cursorRow; r += 1) {
      s.lines[r] = makeLine(s, s.cols);
    }
    clearLine(s, 1);
    return;
  }

  clearLine(s, 0);
  for (let r = s.cursorRow + 1; r < s.lines.length; r += 1) {
    s.lines[r] = makeLine(s, s.cols);
  }
}

export function insertChars(s: VtScreenState, count: number): void {
  ensureCursorRow(s);
  const line = s.lines[s.cursorRow];
  const n = Math.max(1, Math.min(s.cols, count));
  for (let i = s.cols - 1; i >= s.cursorCol + n; i -= 1) {
    line[i] = line[i - n];
  }
  for (let i = 0; i < n && s.cursorCol + i < s.cols; i += 1) {
    line[s.cursorCol + i] = makeCell(s, ' ');
  }
}

export function deleteChars(s: VtScreenState, count: number): void {
  ensureCursorRow(s);
  const line = s.lines[s.cursorRow];
  const n = Math.max(1, Math.min(s.cols, count));
  for (let i = s.cursorCol; i < s.cols - n; i += 1) {
    line[i] = line[i + n];
  }
  for (let i = s.cols - n; i < s.cols; i += 1) {
    line[i] = makeCell(s, ' ');
  }
}

export function eraseChars(s: VtScreenState, count: number): void {
  ensureCursorRow(s);
  const line = s.lines[s.cursorRow];
  const n = Math.max(1, Math.min(s.cols - s.cursorCol, count));
  for (let i = 0; i < n; i += 1) {
    line[s.cursorCol + i] = makeCell(s, ' ');
  }
}

export function trimBottomToRows(s: VtScreenState): void {
  if (!s.usingAltScreen) return;
  while (s.lines.length > s.rows) {
    s.lines.pop();
  }
  while (s.lines.length < s.rows) {
    s.lines.push(makeLine(s, s.cols));
  }
}

export function scrollRegionUp(s: VtScreenState, topLocal: number, bottomLocal: number, count: number): void {
  const top = absoluteRowFromViewport(s, topLocal);
  const bottom = absoluteRowFromViewport(s, bottomLocal);
  const n = Math.max(1, Math.min(bottom - top + 1, count));

  for (let i = 0; i < n; i += 1) {
    s.lines.splice(top, 1);
    s.lines.splice(bottom, 0, makeLine(s, s.cols));
  }
}

export function scrollRegionDown(s: VtScreenState, topLocal: number, bottomLocal: number, count: number): void {
  const top = absoluteRowFromViewport(s, topLocal);
  const bottom = absoluteRowFromViewport(s, bottomLocal);
  const n = Math.max(1, Math.min(bottom - top + 1, count));

  for (let i = 0; i < n; i += 1) {
    s.lines.splice(bottom, 1);
    s.lines.splice(top, 0, makeLine(s, s.cols));
  }
}

export function insertLines(s: VtScreenState, count: number): void {
  ensureCursorRow(s);
  if (!cursorWithinScrollRegion(s)) return;
  const n = Math.max(1, Math.min(absoluteRowFromViewport(s, s.scrollBottom) - s.cursorRow + 1, count));
  const bottom = absoluteRowFromViewport(s, s.scrollBottom);
  for (let i = 0; i < n; i += 1) {
    s.lines.splice(s.cursorRow, 0, makeLine(s, s.cols));
    s.lines.splice(bottom + 1, 1);
  }
  trimBottomToRows(s);
}

export function deleteLines(s: VtScreenState, count: number): void {
  ensureCursorRow(s);
  if (!cursorWithinScrollRegion(s)) return;
  const n = Math.max(1, Math.min(absoluteRowFromViewport(s, s.scrollBottom) - s.cursorRow + 1, count));
  const bottom = absoluteRowFromViewport(s, s.scrollBottom);
  for (let i = 0; i < n; i += 1) {
    if (s.cursorRow < s.lines.length) {
      s.lines.splice(s.cursorRow, 1);
    }
    s.lines.splice(bottom, 0, makeLine(s, s.cols));
  }
  trimBottomToRows(s);
}

export function scrollUp(s: VtScreenState, count: number): void {
  const n = Math.max(1, Math.min(s.rows, count));
  scrollRegionUp(s, s.scrollTop, s.scrollBottom, n);
  trimBottomToRows(s);
}

export function scrollDown(s: VtScreenState, count: number): void {
  const n = Math.max(1, Math.min(s.rows, count));
  scrollRegionDown(s, s.scrollTop, s.scrollBottom, n);
  trimBottomToRows(s);
}

export function enterAltScreen(s: VtScreenState): void {
  if (s.usingAltScreen) return;
  s.savedPrimaryScreen = {
    lines: cloneLines(s.lines),
    cursorRow: s.cursorRow,
    cursorCol: s.cursorCol,
    savedRow: s.savedRow,
    savedCol: s.savedCol,
    scrollTop: s.scrollTop,
    scrollBottom: s.scrollBottom,
    originMode: s.originMode,
    cursorVisible: s.cursorVisible,
  };
  s.usingAltScreen = true;
  s.lines = [];
  while (s.lines.length < s.rows) s.lines.push(makeLine(s, s.cols));
  s.cursorRow = 0;
  s.cursorCol = 0;
  s.savedRow = 0;
  s.savedCol = 0;
  s.scrollTop = 0;
  s.scrollBottom = s.rows - 1;
  s.originMode = false;
  s.cursorVisible = true;
  s.wrapPending = false;
}

export function leaveAltScreen(s: VtScreenState): void {
  if (!s.usingAltScreen) return;
  s.usingAltScreen = false;
  s.wrapPending = false;
  if (!s.savedPrimaryScreen) {
    s.lines = [makeLine(s, s.cols)];
    s.cursorRow = 0;
    s.cursorCol = 0;
    s.savedRow = 0;
    s.savedCol = 0;
    s.scrollTop = 0;
    s.scrollBottom = s.rows - 1;
    return;
  }
  s.lines = cloneLines(s.savedPrimaryScreen.lines);
  s.cursorRow = s.savedPrimaryScreen.cursorRow;
  s.cursorCol = s.savedPrimaryScreen.cursorCol;
  s.savedRow = s.savedPrimaryScreen.savedRow;
  s.savedCol = s.savedPrimaryScreen.savedCol;
  s.scrollTop = s.savedPrimaryScreen.scrollTop;
  s.scrollBottom = s.savedPrimaryScreen.scrollBottom;
  s.originMode = s.savedPrimaryScreen.originMode;
  s.cursorVisible = s.savedPrimaryScreen.cursorVisible;
  s.savedPrimaryScreen = undefined;
}

export function lineFeed(s: VtScreenState): void {
  ensureCursorRow(s);
  const top = absoluteRowFromViewport(s, s.scrollTop);
  const bottom = absoluteRowFromViewport(s, s.scrollBottom);

  if (s.cursorRow >= top && s.cursorRow <= bottom) {
    if (s.cursorRow === bottom) {
      scrollRegionUp(s, s.scrollTop, s.scrollBottom, 1);
    } else {
      s.cursorRow += 1;
    }
    return;
  }

  s.cursorRow += 1;
  ensureCursorRow(s);
}

export function reverseIndex(s: VtScreenState): void {
  ensureCursorRow(s);
  const top = absoluteRowFromViewport(s, s.scrollTop);
  const bottom = absoluteRowFromViewport(s, s.scrollBottom);

  if (s.cursorRow >= top && s.cursorRow <= bottom) {
    if (s.cursorRow === top) {
      scrollRegionDown(s, s.scrollTop, s.scrollBottom, 1);
    } else {
      s.cursorRow -= 1;
    }
    return;
  }

  s.cursorRow = Math.max(0, s.cursorRow - 1);
}

export function cursorWithinScrollRegion(s: VtScreenState): boolean {
  const top = absoluteRowFromViewport(s, s.scrollTop);
  const bottom = absoluteRowFromViewport(s, s.scrollBottom);
  return s.cursorRow >= top && s.cursorRow <= bottom;
}

export function resetToInitialState(s: VtScreenState): void {
  s.lines = [makeLine(s, s.cols)];
  if (s.usingAltScreen) {
    while (s.lines.length < s.rows) s.lines.push(makeLine(s, s.cols));
  }
  s.cursorRow = 0;
  s.cursorCol = 0;
  s.savedRow = 0;
  s.savedCol = 0;
  s.currentStyle = {};
  s.scrollTop = 0;
  s.scrollBottom = s.rows - 1;
  s.originMode = false;
  s.cursorVisible = true;
  s.wrapPending = false;
}

export function setCursorPosition(s: VtScreenState, row: number, col: number): void {
  const safeCol = Math.max(0, col);
  const safeRow = Math.max(0, row);
  s.cursorCol = safeCol;
  s.cursorRow = s.originMode
    ? absoluteRowFromViewport(s, s.scrollTop) + safeRow
    : safeRow;
}

export function setCursorRow(s: VtScreenState, row: number): void {
  const safeRow = Math.max(0, row);
  s.cursorRow = s.originMode
    ? absoluteRowFromViewport(s, s.scrollTop) + safeRow
    : safeRow;
}
