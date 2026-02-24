/**
 * Pure utility functions for VT terminal emulation.
 */

import type { TerminalStyle, TerminalSegment, Cell } from './vt-types.js';

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function styleKey(style: Partial<TerminalSegment | TerminalStyle>): string {
  return `${style.fg || ''}|${style.bg || ''}|${style.bold ? '1' : '0'}|${style.italic ? '1' : '0'}|${style.underline ? '1' : '0'}`;
}

export function applyInverse(style: TerminalStyle): TerminalStyle {
  if (!style.inverse) return style;
  return {
    ...style,
    fg: style.bg,
    bg: style.fg,
    inverse: false,
  };
}

export function toHex(v: number): string {
  const clamped = Math.max(0, Math.min(255, v));
  return clamped.toString(16).padStart(2, '0');
}

export const ANSI_16_COLORS = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];

export function xterm256Color(index: number): string | undefined {
  if (!Number.isFinite(index) || index < 0 || index > 255) return undefined;
  if (index < 16) return ANSI_16_COLORS[index];
  if (index >= 232) {
    const v = 8 + (index - 232) * 10;
    return `#${toHex(v)}${toHex(v)}${toHex(v)}`;
  }

  const i = index - 16;
  const r = Math.floor(i / 36);
  const g = Math.floor((i % 36) / 6);
  const b = i % 6;
  const map = [0, 95, 135, 175, 215, 255];
  return `#${toHex(map[r])}${toHex(map[g])}${toHex(map[b])}`;
}

export function charDisplayWidth(ch: string): number {
  if (!ch) return 0;
  const cp = ch.codePointAt(0);
  if (cp === undefined || cp === 0) return 0;

  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;

  // Combining marks and format controls should not advance cursor columns.
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200d || // zero-width joiner
    (cp >= 0xfe00 && cp <= 0xfe0f) // variation selectors
  ) {
    return 0;
  }

  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }

  return 1;
}

export function cloneLines(lines: Cell[][]): Cell[][] {
  return lines.map((line) => line.map((cell) => ({
    ch: cell.ch,
    style: { ...cell.style },
  })));
}
