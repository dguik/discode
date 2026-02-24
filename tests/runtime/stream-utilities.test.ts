import { describe, expect, it } from 'vitest';
import {
  parseWindowId,
  clampNumber,
  decodeBase64,
  buildStyledSignature,
  buildLinePatch,
  buildStyledPatch,
  cloneStyledLines,
  cloneStyledLine,
} from '../../src/runtime/stream-utilities.js';
import type { TerminalStyledLine } from '../../src/runtime/vt-screen.js';

describe('stream-utilities', () => {
  describe('parseWindowId', () => {
    it('parses valid session:window format', () => {
      expect(parseWindowId('bridge:claude')).toEqual({
        sessionName: 'bridge',
        windowName: 'claude',
      });
    });
    it('handles colons in window name', () => {
      expect(parseWindowId('bridge:win:extra')).toEqual({
        sessionName: 'bridge',
        windowName: 'win:extra',
      });
    });
    it('returns null for missing colon', () => {
      expect(parseWindowId('nocolon')).toBeNull();
    });
    it('returns null for leading colon', () => {
      expect(parseWindowId(':window')).toBeNull();
    });
    it('returns null for trailing colon', () => {
      expect(parseWindowId('session:')).toBeNull();
    });
    it('returns null for empty string', () => {
      expect(parseWindowId('')).toBeNull();
    });
  });

  describe('clampNumber', () => {
    it('returns value within range', () => {
      expect(clampNumber(50, 10, 100, 42)).toBe(50);
    });
    it('clamps to min', () => {
      expect(clampNumber(5, 10, 100, 42)).toBe(10);
    });
    it('clamps to max', () => {
      expect(clampNumber(200, 10, 100, 42)).toBe(100);
    });
    it('floors fractional values', () => {
      expect(clampNumber(50.9, 10, 100, 42)).toBe(50);
    });
    it('returns fallback for undefined', () => {
      expect(clampNumber(undefined, 10, 100, 42)).toBe(42);
    });
    it('returns fallback for NaN', () => {
      expect(clampNumber(NaN, 10, 100, 42)).toBe(42);
    });
  });

  describe('decodeBase64', () => {
    it('decodes valid base64', () => {
      const result = decodeBase64(Buffer.from('hello', 'utf8').toString('base64'));
      expect(result!.toString('utf8')).toBe('hello');
    });
    it('returns null for empty string', () => {
      expect(decodeBase64('')).toBeNull();
    });
    it('returns null for non-string', () => {
      expect(decodeBase64(null as any)).toBeNull();
      expect(decodeBase64(undefined as any)).toBeNull();
    });
  });

  describe('buildStyledSignature', () => {
    it('returns empty for empty lines', () => {
      expect(buildStyledSignature([])).toBe('');
    });
    it('encodes segment text and styles', () => {
      const lines: TerminalStyledLine[] = [
        { segments: [{ text: 'hello', fg: '#ff0000', bold: true }] },
      ];
      const sig = buildStyledSignature(lines);
      expect(sig).toContain('hello');
      expect(sig).toContain('#ff0000');
    });
    it('produces different signatures for different content', () => {
      const a: TerminalStyledLine[] = [{ segments: [{ text: 'aaa' }] }];
      const b: TerminalStyledLine[] = [{ segments: [{ text: 'bbb' }] }];
      expect(buildStyledSignature(a)).not.toBe(buildStyledSignature(b));
    });
    it('produces same signature for same content', () => {
      const a: TerminalStyledLine[] = [{ segments: [{ text: 'same' }] }];
      const b: TerminalStyledLine[] = [{ segments: [{ text: 'same' }] }];
      expect(buildStyledSignature(a)).toBe(buildStyledSignature(b));
    });
  });

  describe('buildLinePatch', () => {
    it('returns null when lines are identical', () => {
      expect(buildLinePatch(['a', 'b'], ['a', 'b'])).toBeNull();
    });
    it('detects changed line', () => {
      const patch = buildLinePatch(['a', 'b'], ['a', 'c']);
      expect(patch).not.toBeNull();
      expect(patch!.ops).toEqual([{ index: 1, line: 'c' }]);
    });
    it('detects added lines', () => {
      const patch = buildLinePatch(['a'], ['a', 'b']);
      expect(patch!.ops).toEqual([{ index: 1, line: 'b' }]);
    });
    it('detects removed lines (treats as empty)', () => {
      const patch = buildLinePatch(['a', 'b'], ['a']);
      expect(patch!.ops).toEqual([{ index: 1, line: '' }]);
    });
    it('handles both empty arrays', () => {
      expect(buildLinePatch([], [])).toBeNull();
    });
  });

  describe('buildStyledPatch', () => {
    it('returns null when lines are identical', () => {
      const lines: TerminalStyledLine[] = [{ segments: [{ text: 'abc' }] }];
      expect(buildStyledPatch(lines, lines)).toBeNull();
    });
    it('detects changed styled line', () => {
      const prev: TerminalStyledLine[] = [{ segments: [{ text: 'abc' }] }];
      const next: TerminalStyledLine[] = [{ segments: [{ text: 'xyz' }] }];
      const patch = buildStyledPatch(prev, next);
      expect(patch).not.toBeNull();
      expect(patch!.ops).toHaveLength(1);
      expect(patch!.ops[0].index).toBe(0);
    });
    it('clones line data in patch ops', () => {
      const next: TerminalStyledLine[] = [{ segments: [{ text: 'xyz' }] }];
      const patch = buildStyledPatch([], next);
      expect(patch!.ops[0].line).not.toBe(next[0]);
      expect(patch!.ops[0].line).toEqual(next[0]);
    });
  });

  describe('cloneStyledLine / cloneStyledLines', () => {
    it('deep clones a styled line', () => {
      const original: TerminalStyledLine = {
        segments: [{ text: 'hello', fg: '#fff', bold: true }],
      };
      const cloned = cloneStyledLine(original);
      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.segments[0]).not.toBe(original.segments[0]);
    });
    it('deep clones multiple lines', () => {
      const originals: TerminalStyledLine[] = [
        { segments: [{ text: 'a' }] },
        { segments: [{ text: 'b' }] },
      ];
      const cloned = cloneStyledLines(originals);
      expect(cloned).toEqual(originals);
      expect(cloned[0]).not.toBe(originals[0]);
    });
    it('mutation does not affect original', () => {
      const original: TerminalStyledLine = { segments: [{ text: 'x' }] };
      const cloned = cloneStyledLine(original);
      cloned.segments[0].text = 'y';
      expect(original.segments[0].text).toBe('x');
    });
  });
});
