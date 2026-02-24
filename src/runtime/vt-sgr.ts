/**
 * SGR (Select Graphic Rendition) parser for VT terminal emulation.
 *
 * Pure function: takes SGR parameter parts and current style,
 * returns the updated style without mutating the input.
 */

import type { TerminalStyle } from './vt-types.js';
import { ANSI_16_COLORS, xterm256Color, toHex } from './vt-utils.js';

/**
 * Apply an SGR sequence to a terminal style.
 *
 * Returns a new TerminalStyle reflecting the SGR codes.
 */
export function applySgr(parts: string[], currentStyle: TerminalStyle): TerminalStyle {
  if (parts.length === 0) {
    return {};
  }

  const style = { ...currentStyle };

  for (let i = 0; i < parts.length; i += 1) {
    const code = parseInt(parts[i] || '0', 10);
    if (!Number.isFinite(code) || code === 0) {
      Object.keys(style).forEach((k) => delete (style as Record<string, unknown>)[k]);
      continue;
    }

    if (code === 1) { style.bold = true; continue; }
    if (code === 3) { style.italic = true; continue; }
    if (code === 4) { style.underline = true; continue; }
    if (code === 7) { style.inverse = true; continue; }
    if (code === 22) { style.bold = false; continue; }
    if (code === 23) { style.italic = false; continue; }
    if (code === 24) { style.underline = false; continue; }
    if (code === 27) { style.inverse = false; continue; }
    if (code === 39) { style.fg = undefined; continue; }
    if (code === 49) { style.bg = undefined; continue; }

    if (code >= 30 && code <= 37) { style.fg = ANSI_16_COLORS[code - 30]; continue; }
    if (code >= 90 && code <= 97) { style.fg = ANSI_16_COLORS[8 + (code - 90)]; continue; }
    if (code >= 40 && code <= 47) { style.bg = ANSI_16_COLORS[code - 40]; continue; }
    if (code >= 100 && code <= 107) { style.bg = ANSI_16_COLORS[8 + (code - 100)]; continue; }

    if ((code === 38 || code === 48) && i + 1 < parts.length) {
      const mode = parseInt(parts[i + 1] || '', 10);
      if (mode === 5 && i + 2 < parts.length) {
        const idx = parseInt(parts[i + 2] || '', 10);
        const color = xterm256Color(idx);
        if (color) {
          if (code === 38) style.fg = color;
          else style.bg = color;
        }
        i += 2;
        continue;
      }
      if (mode === 2 && i + 4 < parts.length) {
        const r = parseInt(parts[i + 2] || '', 10);
        const g = parseInt(parts[i + 3] || '', 10);
        const b = parseInt(parts[i + 4] || '', 10);
        if ([r, g, b].every((v) => Number.isFinite(v))) {
          const color = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
          if (code === 38) style.fg = color;
          else style.bg = color;
        }
        i += 4;
        continue;
      }
    }
  }

  return style;
}
