/**
 * Coarse terminal screen renderer for ANSI stream text.
 *
 * Not a full VT implementation, but handles the common control
 * sequences used by interactive CLIs so the current screen can be shown
 * in the discode TUI panel.
 */

export type TerminalSnapshotOptions = {
  width?: number;
  height?: number;
};

/**
 * Render a coarse terminal screen snapshot from ANSI stream text.
 *
 * This is not a full VT implementation, but handles the common control
 * sequences used by interactive CLIs so the current screen can be shown
 * in the discode TUI panel.
 */
export function renderTerminalSnapshot(text: string, options?: TerminalSnapshotOptions): string {
  const width = Math.max(20, Math.min(240, options?.width || 100));
  const height = Math.max(6, Math.min(120, options?.height || 30));
  const maxRows = Math.max(height * 6, 200);

  const makeRow = () => Array.from({ length: width }, () => ' ');
  let rows: string[][] = [makeRow()];
  let row = 0;
  let col = 0;
  let savedRow = 0;
  let savedCol = 0;
  let absoluteCursorUsed = false;

  const ensureRow = (index: number) => {
    while (rows.length <= index) rows.push(makeRow());
  };

  const trimHeadIfNeeded = () => {
    if (rows.length <= maxRows) return;
    const cut = rows.length - maxRows;
    rows = rows.slice(cut);
    row = Math.max(0, row - cut);
    savedRow = Math.max(0, savedRow - cut);
  };

  const clampCursor = () => {
    if (row < 0) row = 0;
    if (col < 0) col = 0;
    if (col >= width) col = width - 1;
    ensureRow(row);
  };

  const clearLine = (line: number, start: number, end: number) => {
    ensureRow(line);
    const safeStart = Math.max(0, Math.min(width - 1, start));
    const safeEnd = Math.max(0, Math.min(width - 1, end));
    for (let i = safeStart; i <= safeEnd; i++) rows[line][i] = ' ';
  };

  const clearDisplay = (mode: number) => {
    if (mode === 2) {
      rows = [makeRow()];
      row = 0;
      col = 0;
      return;
    }

    ensureRow(row);
    if (mode === 1) {
      for (let r = 0; r < row; r++) {
        clearLine(r, 0, width - 1);
      }
      clearLine(row, 0, col);
      return;
    }

    clearLine(row, col, width - 1);
    for (let r = row + 1; r < rows.length; r++) {
      clearLine(r, 0, width - 1);
    }
  };

  const writeChar = (ch: string) => {
    ensureRow(row);
    rows[row][col] = ch;
    col += 1;
    if (col >= width) {
      col = 0;
      row += 1;
      ensureRow(row);
      trimHeadIfNeeded();
    }
  };

  const parseNumber = (value: string, fallback: number) => {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === '\x1b') {
      const next = text[i + 1];

      // CSI
      if (next === '[') {
        let j = i + 2;
        while (j < text.length && (text.charCodeAt(j) < 0x40 || text.charCodeAt(j) > 0x7e)) j += 1;
        if (j >= text.length) break;

        const final = text[j];
        const rawParams = text.slice(i + 2, j);
        const isPrivate = rawParams.startsWith('?');
        const cleanParams = isPrivate ? rawParams.slice(1) : rawParams;
        const parts = cleanParams.length > 0 ? cleanParams.split(';') : [];
        const param = (index: number, fallback: number) => parseNumber(parts[index] || '', fallback);

        switch (final) {
          case 'A':
            row -= param(0, 1);
            break;
          case 'B':
            row += param(0, 1);
            break;
          case 'C':
            col += param(0, 1);
            break;
          case 'D':
            col -= param(0, 1);
            break;
          case 'E':
            row += param(0, 1);
            col = 0;
            break;
          case 'F':
            row -= param(0, 1);
            col = 0;
            break;
          case 'G':
            col = Math.max(0, param(0, 1) - 1);
            absoluteCursorUsed = true;
            break;
          case 'H':
          case 'f':
            row = Math.max(0, param(0, 1) - 1);
            col = Math.max(0, param(1, 1) - 1);
            absoluteCursorUsed = true;
            break;
          case 'd':
            row = Math.max(0, param(0, 1) - 1);
            absoluteCursorUsed = true;
            break;
          case 'J':
            clearDisplay(param(0, 0));
            absoluteCursorUsed = true;
            break;
          case 'K': {
            const mode = param(0, 0);
            if (mode === 1) clearLine(row, 0, col);
            else if (mode === 2) clearLine(row, 0, width - 1);
            else clearLine(row, col, width - 1);
            break;
          }
          case 's':
            savedRow = row;
            savedCol = col;
            break;
          case 'u':
            row = savedRow;
            col = savedCol;
            break;
          case 'm':
            // SGR styling ignored in text snapshot
            break;
          case 'h':
          case 'l':
            if (isPrivate && (param(0, 0) === 1049 || param(0, 0) === 47)) {
              // Alternate screen enter/leave
              clearDisplay(2);
              absoluteCursorUsed = true;
            }
            break;
          default:
            break;
        }

        clampCursor();
        trimHeadIfNeeded();
        i = j + 1;
        continue;
      }

      // OSC
      if (next === ']') {
        let j = i + 2;
        while (j < text.length) {
          if (text[j] === '\x07') {
            j += 1;
            break;
          }
          if (text[j] === '\x1b' && text[j + 1] === '\\') {
            j += 2;
            break;
          }
          j += 1;
        }
        i = j;
        continue;
      }

      i += 2;
      continue;
    }

    if (ch === '\r') {
      col = 0;
      i += 1;
      continue;
    }

    if (ch === '\n') {
      row += 1;
      col = 0;
      ensureRow(row);
      trimHeadIfNeeded();
      i += 1;
      continue;
    }

    if (ch === '\b') {
      col = Math.max(0, col - 1);
      i += 1;
      continue;
    }

    if (ch === '\t') {
      const spaces = 8 - (col % 8);
      for (let s = 0; s < spaces; s++) writeChar(' ');
      i += 1;
      continue;
    }

    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      i += 1;
      continue;
    }

    writeChar(ch);
    i += 1;
  }

  const viewRows = absoluteCursorUsed
    ? rows.slice(0, Math.max(height, Math.min(rows.length, height)))
    : rows.slice(Math.max(0, rows.length - height));

  const lines = viewRows.map((r) => r.join(''));
  return lines.join('\n');
}
