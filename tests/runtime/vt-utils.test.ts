import { describe, expect, it } from 'vitest';
import {
  clamp,
  styleKey,
  applyInverse,
  toHex,
  ANSI_16_COLORS,
  xterm256Color,
  charDisplayWidth,
  cloneLines,
} from '../../src/runtime/vt-utils.js';

describe('vt-utils', () => {
  describe('clamp', () => {
    it('returns value within range', () => {
      expect(clamp(50, 0, 100)).toBe(50);
    });
    it('clamps to min', () => {
      expect(clamp(-5, 0, 100)).toBe(0);
    });
    it('clamps to max', () => {
      expect(clamp(200, 0, 100)).toBe(100);
    });
    it('floors fractional values', () => {
      expect(clamp(3.7, 0, 100)).toBe(3);
    });
    it('returns min for NaN', () => {
      expect(clamp(NaN, 10, 100)).toBe(10);
    });
    it('returns min for Infinity', () => {
      expect(clamp(Infinity, 10, 100)).toBe(10);
    });
  });

  describe('styleKey', () => {
    it('returns key for empty style', () => {
      expect(styleKey({})).toBe('||0|0|0');
    });
    it('encodes fg and bold', () => {
      expect(styleKey({ fg: '#ff0000', bold: true })).toBe('#ff0000||1|0|0');
    });
    it('encodes all properties', () => {
      expect(styleKey({ fg: '#fff', bg: '#000', bold: true, italic: true, underline: true }))
        .toBe('#fff|#000|1|1|1');
    });
  });

  describe('applyInverse', () => {
    it('returns same style when not inverse', () => {
      const style = { fg: '#ff0000', bg: '#00ff00' };
      expect(applyInverse(style)).toBe(style);
    });
    it('swaps fg and bg when inverse', () => {
      const result = applyInverse({ fg: '#ff0000', bg: '#00ff00', inverse: true });
      expect(result.fg).toBe('#00ff00');
      expect(result.bg).toBe('#ff0000');
      expect(result.inverse).toBe(false);
    });
    it('handles undefined fg/bg with inverse', () => {
      const result = applyInverse({ inverse: true });
      expect(result.fg).toBeUndefined();
      expect(result.bg).toBeUndefined();
    });
  });

  describe('toHex', () => {
    it('converts 0', () => {
      expect(toHex(0)).toBe('00');
    });
    it('converts 255', () => {
      expect(toHex(255)).toBe('ff');
    });
    it('pads single digit', () => {
      expect(toHex(10)).toBe('0a');
    });
    it('clamps negative to 00', () => {
      expect(toHex(-1)).toBe('00');
    });
    it('clamps above 255', () => {
      expect(toHex(300)).toBe('ff');
    });
  });

  describe('ANSI_16_COLORS', () => {
    it('has 16 entries', () => {
      expect(ANSI_16_COLORS).toHaveLength(16);
    });
    it('starts with black', () => {
      expect(ANSI_16_COLORS[0]).toBe('#000000');
    });
    it('ends with white', () => {
      expect(ANSI_16_COLORS[15]).toBe('#ffffff');
    });
  });

  describe('xterm256Color', () => {
    it('returns ANSI color for index 0-15', () => {
      expect(xterm256Color(0)).toBe('#000000');
      expect(xterm256Color(1)).toBe('#cd3131');
      expect(xterm256Color(15)).toBe('#ffffff');
    });
    it('returns 6x6x6 cube color', () => {
      const color = xterm256Color(16); // r=0, g=0, b=0
      expect(color).toBe('#000000');
    });
    it('returns grayscale ramp color', () => {
      const color = xterm256Color(232); // v = 8
      expect(color).toBe('#080808');
    });
    it('returns grayscale ramp at high end', () => {
      const color = xterm256Color(255); // v = 8 + 23*10 = 238
      expect(color).toBe('#eeeeee');
    });
    it('returns undefined for out of range', () => {
      expect(xterm256Color(-1)).toBeUndefined();
      expect(xterm256Color(256)).toBeUndefined();
      expect(xterm256Color(NaN)).toBeUndefined();
    });
    it('returns valid hex for all 256 colors', () => {
      for (let i = 0; i < 256; i++) {
        const color = xterm256Color(i);
        expect(color).toMatch(/^#[0-9a-f]{6}$/);
      }
    });
  });

  describe('charDisplayWidth', () => {
    it('returns 1 for ASCII', () => {
      expect(charDisplayWidth('a')).toBe(1);
      expect(charDisplayWidth('Z')).toBe(1);
      expect(charDisplayWidth('!')).toBe(1);
    });
    it('returns 0 for empty/null', () => {
      expect(charDisplayWidth('')).toBe(0);
    });
    it('returns 0 for control characters', () => {
      expect(charDisplayWidth('\x00')).toBe(0);
      expect(charDisplayWidth('\x1b')).toBe(0);
      expect(charDisplayWidth('\x7f')).toBe(0);
    });
    it('returns 2 for CJK characters', () => {
      expect(charDisplayWidth('漢')).toBe(2);
      expect(charDisplayWidth('한')).toBe(2);
    });
    it('returns 2 for emoji', () => {
      expect(charDisplayWidth('😀')).toBe(2);
    });
    it('returns 0 for combining marks', () => {
      expect(charDisplayWidth('\u0301')).toBe(0); // combining acute accent
      expect(charDisplayWidth('\u0300')).toBe(0); // combining grave accent
    });
    it('returns 0 for zero-width joiner', () => {
      expect(charDisplayWidth('\u200d')).toBe(0);
    });
  });

  describe('cloneLines', () => {
    it('creates deep copy', () => {
      const original = [[{ ch: 'a', style: { fg: '#fff' } }]];
      const cloned = cloneLines(original);
      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned[0]).not.toBe(original[0]);
      expect(cloned[0][0]).not.toBe(original[0][0]);
      expect(cloned[0][0].style).not.toBe(original[0][0].style);
    });
    it('mutation does not affect original', () => {
      const original = [[{ ch: 'a', style: { fg: '#fff' } }]];
      const cloned = cloneLines(original);
      cloned[0][0].ch = 'b';
      cloned[0][0].style.fg = '#000';
      expect(original[0][0].ch).toBe('a');
      expect(original[0][0].style.fg).toBe('#fff');
    });
    it('handles empty lines', () => {
      expect(cloneLines([])).toEqual([]);
    });
  });
});
