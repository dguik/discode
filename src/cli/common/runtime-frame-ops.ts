import type { TerminalStyledLine } from '../../runtime/vt-screen.js';

export type PatchOp = { index: number; line: string };
export type StyledPatchOp = { index: number; line: TerminalStyledLine };

function cloneSegments(line: TerminalStyledLine): TerminalStyledLine {
  return {
    segments: line.segments.map((seg) => ({
      text: seg.text,
      fg: seg.fg,
      bg: seg.bg,
      bold: seg.bold,
      italic: seg.italic,
      underline: seg.underline,
    })),
  };
}

const EMPTY_STYLED_LINE: TerminalStyledLine = {
  segments: [{ text: '', fg: undefined, bg: undefined, bold: undefined, italic: undefined, underline: undefined }],
};

export function styledLinesToPlainText(lines: TerminalStyledLine[]): string {
  return lines
    .map((line) => line.segments.map((seg) => seg.text).join(''))
    .join('\n');
}

export function applyStyledPatch(
  current: TerminalStyledLine[],
  lineCount: number,
  ops: StyledPatchOp[],
): TerminalStyledLine[] {
  const next = current.slice(0, lineCount).map(cloneSegments);
  while (next.length < lineCount) {
    next.push(cloneSegments(EMPTY_STYLED_LINE));
  }
  for (const op of ops) {
    if (op.index >= 0 && op.index < lineCount) {
      next[op.index] = cloneSegments(op.line);
    }
  }
  return next;
}

export function applyPlainPatch(
  current: string[],
  lineCount: number,
  ops: PatchOp[],
): string[] {
  const next = current.slice(0, lineCount);
  while (next.length < lineCount) next.push('');
  for (const op of ops) {
    if (op.index >= 0 && op.index < lineCount) {
      next[op.index] = op.line;
    }
  }
  return next;
}
