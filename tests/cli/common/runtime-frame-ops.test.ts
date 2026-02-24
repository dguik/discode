import { describe, expect, it } from 'vitest';
import type { TerminalStyledLine } from '../../../src/runtime/vt-screen.js';
import {
  applyStyledPatch,
  applyPlainPatch,
  styledLinesToPlainText,
  type StyledPatchOp,
  type PatchOp,
} from '../../../src/cli/common/runtime-frame-ops.js';

function styledLine(text: string): TerminalStyledLine {
  return { segments: [{ text }] };
}

describe('styledLinesToPlainText', () => {
  it('returns empty string for empty array', () => {
    expect(styledLinesToPlainText([])).toBe('');
  });

  it('joins segment texts within a line', () => {
    const lines: TerminalStyledLine[] = [
      { segments: [{ text: 'hello' }, { text: ' world' }] },
    ];
    expect(styledLinesToPlainText(lines)).toBe('hello world');
  });

  it('joins multiple lines with newline', () => {
    const lines: TerminalStyledLine[] = [styledLine('line1'), styledLine('line2'), styledLine('line3')];
    expect(styledLinesToPlainText(lines)).toBe('line1\nline2\nline3');
  });

  it('handles lines with empty segments', () => {
    const lines: TerminalStyledLine[] = [{ segments: [{ text: '' }] }];
    expect(styledLinesToPlainText(lines)).toBe('');
  });
});

describe('applyStyledPatch', () => {
  it('pads with empty lines when current is shorter than lineCount', () => {
    const result = applyStyledPatch([], 3, []);
    expect(result).toHaveLength(3);
    expect(styledLinesToPlainText(result)).toBe('\n\n');
  });

  it('truncates when current is longer than lineCount', () => {
    const current = [styledLine('a'), styledLine('b'), styledLine('c'), styledLine('d')];
    const result = applyStyledPatch(current, 2, []);
    expect(result).toHaveLength(2);
    expect(styledLinesToPlainText(result)).toBe('a\nb');
  });

  it('applies single op', () => {
    const current = [styledLine('old')];
    const ops: StyledPatchOp[] = [{ index: 0, line: styledLine('new') }];
    const result = applyStyledPatch(current, 1, ops);
    expect(styledLinesToPlainText(result)).toBe('new');
  });

  it('applies multiple ops', () => {
    const current = [styledLine('a'), styledLine('b'), styledLine('c')];
    const ops: StyledPatchOp[] = [
      { index: 0, line: styledLine('A') },
      { index: 2, line: styledLine('C') },
    ];
    const result = applyStyledPatch(current, 3, ops);
    expect(styledLinesToPlainText(result)).toBe('A\nb\nC');
  });

  it('ignores ops with index out of range', () => {
    const current = [styledLine('a')];
    const ops: StyledPatchOp[] = [
      { index: -1, line: styledLine('neg') },
      { index: 5, line: styledLine('big') },
    ];
    const result = applyStyledPatch(current, 1, ops);
    expect(styledLinesToPlainText(result)).toBe('a');
  });

  it('does not mutate original array', () => {
    const original = [styledLine('orig')];
    const ops: StyledPatchOp[] = [{ index: 0, line: styledLine('patched') }];
    applyStyledPatch(original, 1, ops);
    expect(original[0].segments[0].text).toBe('orig');
  });

  it('deep-clones segment properties', () => {
    const line: TerminalStyledLine = {
      segments: [{ text: 'bold', fg: '#ff0000', bold: true }],
    };
    const result = applyStyledPatch([], 1, [{ index: 0, line }]);
    expect(result[0].segments[0]).not.toBe(line.segments[0]);
    expect(result[0].segments[0].text).toBe('bold');
    expect(result[0].segments[0].fg).toBe('#ff0000');
    expect(result[0].segments[0].bold).toBe(true);
  });
});

describe('applyPlainPatch', () => {
  it('pads with empty strings when current is shorter than lineCount', () => {
    const result = applyPlainPatch([], 3, []);
    expect(result).toEqual(['', '', '']);
  });

  it('truncates when current is longer than lineCount', () => {
    const result = applyPlainPatch(['a', 'b', 'c', 'd'], 2, []);
    expect(result).toEqual(['a', 'b']);
  });

  it('applies single op', () => {
    const ops: PatchOp[] = [{ index: 0, line: 'new' }];
    const result = applyPlainPatch(['old'], 1, ops);
    expect(result).toEqual(['new']);
  });

  it('applies multiple ops', () => {
    const ops: PatchOp[] = [
      { index: 0, line: 'A' },
      { index: 2, line: 'C' },
    ];
    const result = applyPlainPatch(['a', 'b', 'c'], 3, ops);
    expect(result).toEqual(['A', 'b', 'C']);
  });

  it('ignores ops with negative index', () => {
    const result = applyPlainPatch(['a'], 1, [{ index: -1, line: 'bad' }]);
    expect(result).toEqual(['a']);
  });

  it('ignores ops with index >= lineCount', () => {
    const result = applyPlainPatch(['a'], 1, [{ index: 1, line: 'bad' }]);
    expect(result).toEqual(['a']);
  });

  it('does not mutate original array', () => {
    const original = ['orig'];
    applyPlainPatch(original, 1, [{ index: 0, line: 'patched' }]);
    expect(original).toEqual(['orig']);
  });

  it('handles zero lineCount', () => {
    const result = applyPlainPatch(['a', 'b'], 0, []);
    expect(result).toEqual([]);
  });
});
