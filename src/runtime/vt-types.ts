/**
 * Terminal emulator types shared across VT modules.
 */

export type TerminalStyle = {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
};

export type TerminalSegment = {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
};

export type TerminalStyledLine = {
  segments: TerminalSegment[];
};

export type TerminalStyledFrame = {
  cols: number;
  rows: number;
  lines: TerminalStyledLine[];
  cursorRow: number;
  cursorCol: number;
  cursorVisible: boolean;
};

export type Cell = {
  ch: string;
  style: TerminalStyle;
};

export type SavedScreenState = {
  lines: Cell[][];
  cursorRow: number;
  cursorCol: number;
  savedRow: number;
  savedCol: number;
  scrollTop: number;
  scrollBottom: number;
  originMode: boolean;
  cursorVisible: boolean;
};
