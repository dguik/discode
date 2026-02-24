import { incRuntimeMetric } from './vt-diagnostics.js';
import type {
  TerminalSegment,
  TerminalStyledLine,
  TerminalStyledFrame,
  Cell,
  VtScreenState,
} from './vt-types.js';
import {
  clamp,
  styleKey,
  applyInverse,
  charDisplayWidth,
} from './vt-utils.js';
import { applySgr } from './vt-sgr.js';
import { parseVtStream } from './vt-escape-parser.js';
import * as bufOps from './vt-screen-buffer-ops.js';

export type { TerminalStyle, TerminalSegment, TerminalStyledLine, TerminalStyledFrame } from './vt-types.js';

export class VtScreen {
  private state: VtScreenState;
  private pendingInput = '';

  constructor(cols = 120, rows = 40, scrollback = 2000) {
    const c = clamp(cols, 20, 300);
    const r = clamp(rows, 6, 200);
    this.state = {
      cols: c,
      rows: r,
      scrollback: Math.max(r * 4, scrollback),
      lines: [],
      cursorRow: 0,
      cursorCol: 0,
      savedRow: 0,
      savedCol: 0,
      currentStyle: {},
      usingAltScreen: false,
      scrollTop: 0,
      scrollBottom: r - 1,
      wrapPending: false,
      originMode: false,
      cursorVisible: true,
    };
    this.state.lines = [bufOps.makeLine(this.state, c)];
  }

  write(chunk: string): void {
    let data = this.pendingInput + chunk;
    this.pendingInput = '';

    if (data.length === 0) return;
    if (data.length > 32_768) {
      data = data.slice(-32_768);
    }

    const s = this.state;
    const carry = parseVtStream(data, (action) => {
      switch (action.type) {
        case 'csi': this.handleCsi(action.raw, action.final); break;
        case 'print': this.writeChar(action.ch); break;
        case 'cr': s.wrapPending = false; s.cursorCol = 0; break;
        case 'lf': s.wrapPending = false; bufOps.lineFeed(s); break;
        case 'bs': s.wrapPending = false; s.cursorCol = Math.max(0, s.cursorCol - 1); break;
        case 'tab': { const spaces = 8 - (s.cursorCol % 8); for (let t = 0; t < spaces; t += 1) this.writeChar(' '); break; }
        case 'decsc': s.savedRow = s.cursorRow; s.savedCol = s.cursorCol; break;
        case 'decrc': s.wrapPending = false; s.cursorRow = s.savedRow; s.cursorCol = s.savedCol; bufOps.clampCursor(s); bufOps.ensureCursorRow(s); break;
        case 'ris': bufOps.resetToInitialState(s); break;
        case 'index': s.wrapPending = false; bufOps.lineFeed(s); break;
        case 'next_line': s.wrapPending = false; s.cursorCol = 0; bufOps.lineFeed(s); break;
        case 'reverse_index': s.wrapPending = false; bufOps.reverseIndex(s); break;
        case 'noop': break;
      }
    });

    this.pendingInput = carry;
  }

  resize(cols: number, rows: number): void {
    const s = this.state;
    const nextCols = clamp(cols, 20, 300);
    const nextRows = clamp(rows, 6, 200);
    if (nextCols === s.cols && nextRows === s.rows) return;

    for (let r = 0; r < s.lines.length; r += 1) {
      const line = s.lines[r];
      if (line.length < nextCols) {
        s.lines[r] = line.concat(bufOps.makeLine(s, nextCols - line.length));
      } else if (line.length > nextCols) {
        s.lines[r] = line.slice(0, nextCols);
      }
    }

    s.cols = nextCols;
    s.rows = nextRows;
    s.scrollback = Math.max(s.rows * 4, s.scrollback);
    s.cursorCol = Math.min(s.cursorCol, s.cols - 1);
    s.scrollTop = Math.max(0, Math.min(s.rows - 1, s.scrollTop));
    s.scrollBottom = Math.max(s.scrollTop, Math.min(s.rows - 1, s.scrollBottom));
    s.wrapPending = false;
  }

  snapshot(cols?: number, rows?: number): TerminalStyledFrame {
    const s = this.state;
    const viewCols = clamp(cols || s.cols, 20, 300);
    const viewRows = clamp(rows || s.rows, 6, 200);
    const start = Math.max(0, s.lines.length - viewRows);
    const lines = s.lines.slice(start, start + viewRows).map((line) => this.toStyledLine(line, viewCols));

    while (lines.length < viewRows) {
      lines.push({ segments: [{ text: ' '.repeat(viewCols) }] });
    }

    const cursorRow = Math.max(0, Math.min(viewRows - 1, s.cursorRow - start));
    const cursorCol = Math.max(0, Math.min(viewCols - 1, s.cursorCol));

    return {
      cols: viewCols,
      rows: viewRows,
      lines,
      cursorRow,
      cursorCol,
      cursorVisible: s.cursorVisible,
    };
  }

  getCursorPosition(): { row: number; col: number } {
    return { row: this.state.cursorRow, col: this.state.cursorCol };
  }

  getDimensions(): { cols: number; rows: number } {
    return { cols: this.state.cols, rows: this.state.rows };
  }

  private handleCsi(rawParams: string, final: string): void {
    const s = this.state;
    if (final !== 'm' && final !== 'h' && final !== 'l') {
      s.wrapPending = false;
    }
    const isPrivate = rawParams.startsWith('?');
    const clean = isPrivate ? rawParams.slice(1) : rawParams;
    const parts = clean.length > 0 ? clean.split(';') : [];
    const param = (index: number, fallback: number) => {
      const parsed = parseInt(parts[index] || '', 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const privateParams = parts
      .map((part) => parseInt(part || '', 10))
      .filter((value) => Number.isFinite(value));

    switch (final) {
      case 'A':
        s.cursorRow -= param(0, 1);
        break;
      case 'B':
        s.cursorRow += param(0, 1);
        break;
      case 'C':
        s.cursorCol += param(0, 1);
        break;
      case 'D':
        s.cursorCol -= param(0, 1);
        break;
      case 'E':
        s.cursorRow += param(0, 1);
        s.cursorCol = 0;
        break;
      case 'F':
        s.cursorRow -= param(0, 1);
        s.cursorCol = 0;
        break;
      case 'G':
        s.cursorCol = Math.max(0, param(0, 1) - 1);
        break;
      case 'H':
      case 'f':
        bufOps.setCursorPosition(s, param(0, 1) - 1, param(1, 1) - 1);
        break;
      case 'd':
        bufOps.setCursorRow(s, param(0, 1) - 1);
        break;
      case 'r': {
        const top = Math.max(1, param(0, 1));
        const bottom = parts.length >= 2 ? Math.max(1, param(1, s.rows)) : s.rows;
        if (top < bottom && bottom <= s.rows) {
          s.scrollTop = top - 1;
          s.scrollBottom = bottom - 1;
          s.cursorRow = s.originMode ? bufOps.absoluteRowFromViewport(s, s.scrollTop) : 0;
          s.cursorCol = 0;
        }
        break;
      }
      case 'J':
        bufOps.clearDisplay(s, param(0, 0));
        break;
      case 'K':
        bufOps.clearLine(s, param(0, 0));
        break;
      case '@':
        bufOps.insertChars(s, param(0, 1));
        break;
      case 'P':
        bufOps.deleteChars(s, param(0, 1));
        break;
      case 'X':
        bufOps.eraseChars(s, param(0, 1));
        break;
      case 'L':
        bufOps.insertLines(s, param(0, 1));
        break;
      case 'M':
        bufOps.deleteLines(s, param(0, 1));
        break;
      case 'S':
        bufOps.scrollUp(s, param(0, 1));
        break;
      case 'T':
        bufOps.scrollDown(s, param(0, 1));
        break;
      case 's':
        s.savedRow = s.cursorRow;
        s.savedCol = s.cursorCol;
        break;
      case 'u':
        s.cursorRow = s.savedRow;
        s.cursorCol = s.savedCol;
        break;
      case 'm':
        s.currentStyle = applySgr(parts, s.currentStyle);
        break;
      case 'h':
      case 'l':
        if (isPrivate) {
          const enable = final === 'h';
          for (const mode of privateParams) {
            if (mode === 1049 || mode === 1047 || mode === 47) {
              if (enable) bufOps.enterAltScreen(s);
              else bufOps.leaveAltScreen(s);
              continue;
            }
            if (mode === 6) {
              s.originMode = enable;
              s.cursorCol = 0;
              s.cursorRow = enable ? bufOps.absoluteRowFromViewport(s, s.scrollTop) : 0;
              continue;
            }
            if (mode === 25) {
              s.cursorVisible = enable;
              continue;
            }
          }
        }
        break;
      default:
        incRuntimeMetric('vt_unknown_csi', { final });
        break;
    }

    bufOps.clampCursor(s);
    bufOps.ensureCursorRow(s);
  }

  private writeChar(ch: string): void {
    const s = this.state;
    const width = charDisplayWidth(ch);
    if (width === 0) {
      this.appendCombiningChar(ch);
      return;
    }
    if (this.shouldJoinWithPrevious(ch)) {
      this.appendCombiningChar(ch);
      return;
    }

    if (s.wrapPending) {
      s.wrapPending = false;
      s.cursorCol = 0;
      bufOps.lineFeed(s);
    }
    bufOps.ensureCursorRow(s);
    bufOps.clampCursor(s);

    if (width === 1) {
      s.lines[s.cursorRow][s.cursorCol] = bufOps.makeCell(s, ch);
      if (s.cursorCol < s.cols - 1) {
        s.cursorCol += 1;
      } else {
        s.wrapPending = true;
      }
      return;
    }

    if (s.cursorCol >= s.cols - 1) {
      s.cursorCol = 0;
      bufOps.lineFeed(s);
      bufOps.ensureCursorRow(s);
      bufOps.clampCursor(s);
    }

    s.lines[s.cursorRow][s.cursorCol] = bufOps.makeCell(s, ch);
    if (s.cursorCol + 1 < s.cols) {
      s.lines[s.cursorRow][s.cursorCol + 1] = bufOps.makeCell(s, '');
    }

    if (s.cursorCol < s.cols - 2) {
      s.cursorCol += 2;
    } else {
      s.cursorCol = s.cols - 1;
      s.wrapPending = true;
    }
  }

  private appendCombiningChar(ch: string): void {
    const s = this.state;
    bufOps.ensureCursorRow(s);
    bufOps.clampCursor(s);
    const line = s.lines[s.cursorRow];
    if (!line || line.length === 0) return;

    const targetCol = s.cursorCol > 0 ? s.cursorCol - 1 : s.cursorCol;
    const target = line[targetCol];
    if (!target) return;

    target.ch += ch;
  }

  private shouldJoinWithPrevious(ch: string): boolean {
    const s = this.state;
    if (s.cursorCol <= 0) return false;
    bufOps.ensureCursorRow(s);
    bufOps.clampCursor(s);
    const line = s.lines[s.cursorRow];
    if (!line) return false;
    const target = line[s.cursorCol - 1];
    if (!target || target.ch.length === 0) return false;
    return target.ch.endsWith('\u200d') && charDisplayWidth(ch) > 0;
  }

  private toStyledLine(line: Cell[], cols: number): TerminalStyledLine {
    const s = this.state;
    const segments: TerminalSegment[] = [];

    let current: TerminalSegment | null = null;
    for (let i = 0; i < cols; i += 1) {
      const cell = line[i] || bufOps.makeCell(s, ' ');
      const style = applyInverse(cell.style);
      const nextStyleKey = styleKey(style);

      if (!current || styleKey(current) !== nextStyleKey) {
        if (current) segments.push(current);
        current = {
          text: cell.ch,
          fg: style.fg,
          bg: style.bg,
          bold: style.bold,
          italic: style.italic,
          underline: style.underline,
        };
      } else {
        current.text += cell.ch;
      }
    }
    if (current) segments.push(current);

    if (segments.length === 0) {
      segments.push({ text: ' '.repeat(cols) });
    }

    return { segments };
  }
}
