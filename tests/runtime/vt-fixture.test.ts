import { describe, expect, it } from 'vitest';
import { VtScreen } from '../../src/runtime/vt-screen.js';

type VtFixture = {
  name: string;
  cols?: number;
  rows?: number;
  chunks: string[];
  expect: {
    cursor?: { row: number; col: number };
    cursorVisible?: boolean;
    contains?: string[];
    notContains?: string[];
    lineStarts?: Array<{ index: number; text: string }>;
    lineEquals?: Array<{ index: number; text: string }>;
    anyLineStarts?: string[];
  };
};

const fixtures: VtFixture[] = [
  {
    name: 'sgr basic color text',
    chunks: ['\x1b[31mred\x1b[0m normal'],
    expect: {
      contains: ['red normal'],
      cursor: { row: 0, col: 10 },
    },
  },
  {
    name: 'clear and home before next text',
    cols: 10,
    rows: 4,
    chunks: ['hello', '\x1b[2J\x1b[H', 'new'],
    expect: {
      lineStarts: [{ index: 0, text: 'new' }],
      cursor: { row: 0, col: 3 },
    },
  },
  {
    name: 'alt-screen restore primary buffer',
    chunks: ['primary', '\x1b[?1049h', 'alt-screen', '\x1b[?1049l'],
    expect: {
      contains: ['primary'],
      notContains: ['alt-screen'],
      cursor: { row: 0, col: 7 },
    },
  },
  {
    name: 'insert and delete chars',
    cols: 12,
    rows: 4,
    chunks: ['abcdef', '\r\x1b[3C', '\x1b[2@', 'XY', '\r\x1b[1P'],
    expect: {
      lineStarts: [{ index: 0, text: 'bcXYdef' }],
      cursor: { row: 0, col: 0 },
    },
  },
  {
    name: 'split CSI chunk carry',
    cols: 30,
    chunks: ['\x1b[38;2;255', ';255;255mWHITE\x1b[0m'],
    expect: {
      contains: ['WHITE'],
      notContains: [';255m', '10m'],
      cursor: { row: 0, col: 5 },
    },
  },
  {
    name: 'complete OSC is not leaked',
    cols: 30,
    chunks: ['\x1b]0;title\x07', 'VISIBLE'],
    expect: {
      contains: ['VISIBLE'],
      notContains: ['title'],
      cursor: { row: 0, col: 7 },
    },
  },
  {
    name: 'line feed keeps column',
    cols: 12,
    rows: 4,
    chunks: ['AB', '\n', 'C'],
    expect: {
      lineStarts: [{ index: 1, text: '  C' }],
      cursor: { row: 1, col: 3 },
    },
  },
  {
    name: 'CSI 2J keeps cursor position',
    cols: 12,
    rows: 4,
    chunks: ['12345', '\x1b[10G', '\x1b[2J', 'X'],
    expect: {
      contains: ['         X'],
      cursor: { row: 0, col: 10 },
    },
  },
  {
    name: 'deferred wrap until next printable char',
    chunks: ['ABCDEFGHIJ0123456789', '\x1b[31m', 'X'],
    expect: {
      lineEquals: [{ index: 0, text: 'ABCDEFGHIJ0123456789' }],
      lineStarts: [{ index: 1, text: 'X' }],
      cursor: { row: 1, col: 1 },
    },
  },
  {
    name: 'deferred wrap does not spuriously scroll in alt-screen',
    chunks: ['\x1b[?1049h', '\x1b[6;1H', 'ABCDEFGHIJ0123456789', '\x1b[1;1H', 'HEAD'],
    expect: {
      lineStarts: [
        { index: 0, text: 'HEAD' },
        { index: 5, text: 'ABCDEFGHIJ0123456789' },
      ],
      cursor: { row: 0, col: 4 },
    },
  },
  {
    name: 'DECSTBM scroll region line-feed behavior',
    chunks: [
      '\x1b[?1049h',
      '\x1b[2;5r',
      '\x1b[1;1Hfixed-head',
      '\x1b[2;1HA-top',
      '\x1b[3;1Hmid-1',
      '\x1b[4;1Hmid-2',
      '\x1b[5;1Hbottom',
      '\x1b[6;1Hfixed-tail',
      '\x1b[5;1H',
      '\n',
      'after-scroll',
    ],
    expect: {
      contains: ['fixed-head', 'fixed-tail', 'after-scroll'],
    },
  },
  {
    name: 'combining mark stays in same cell',
    cols: 10,
    rows: 4,
    chunks: ['e\u0301'],
    expect: {
      contains: ['e\u0301'],
      cursor: { row: 0, col: 1 },
    },
  },
  {
    name: 'combining mark after full line does not trigger early wrap',
    chunks: ['ABCDEFGHIJ0123456789', '\u0301', 'X'],
    expect: {
      lineStarts: [{ index: 1, text: 'X' }],
      cursor: { row: 1, col: 1 },
    },
  },
  {
    name: 'cursor restored after leaving alt-screen',
    chunks: ['\x1b[2;5H', '\x1b[?1049h', '\x1b[1;1Halt', '\x1b[?1049l', 'X'],
    expect: {
      lineStarts: [{ index: 1, text: '    X' }],
      cursor: { row: 1, col: 5 },
    },
  },
  {
    name: 'reverse index at top of scroll region',
    chunks: [
      '\x1b[?1049h',
      '\x1b[2;5r',
      '\x1b[2;1HR1',
      '\x1b[3;1HR2',
      '\x1b[4;1HR3',
      '\x1b[5;1HR4',
      '\x1b[2;1H',
      '\x1bM',
      'N',
    ],
    expect: {
      anyLineStarts: ['N', 'R1'],
    },
  },
  {
    name: 'tab expands to 8-column boundary',
    chunks: ['A\tB'],
    expect: {
      lineStarts: [{ index: 0, text: 'A       B' }],
      cursor: { row: 0, col: 9 },
    },
  },
  {
    name: 'backspace overwrite edit',
    chunks: ['abc\bZ'],
    expect: {
      lineStarts: [{ index: 0, text: 'abZ' }],
      cursor: { row: 0, col: 3 },
    },
  },
  {
    name: 'save and restore cursor with CSI s/u',
    chunks: ['\x1b[2;2HAA', '\x1b[s', '\x1b[4;5HBB', '\x1b[u', 'C'],
    expect: {
      contains: [' AAC', '    BB'],
      cursor: { row: 1, col: 4 },
    },
  },
  {
    name: 'save and restore cursor with ESC 7/8',
    chunks: ['\x1b[2;2HAA', '\x1b7', '\x1b[4;5HBB', '\x1b8', 'C'],
    expect: {
      contains: [' AAC', '    BB'],
      cursor: { row: 1, col: 4 },
    },
  },
  {
    name: 'cursor hidden with DECSET 25l',
    chunks: ['\x1b[?25l'],
    expect: {
      cursorVisible: false,
    },
  },
  {
    name: 'DECOM origin mode affects cursor addressing',
    chunks: ['\x1b[?1049h', '\x1b[2;5r', '\x1b[?6h', '\x1b[1;1HX', '\x1b[4;1HY', '\x1b[?6l', '\x1b[1;1HZ'],
    expect: {
      lineStarts: [
        { index: 0, text: 'Z' },
        { index: 1, text: 'X' },
        { index: 4, text: 'Y' },
      ],
    },
  },
  {
    name: 'SCS sequences are ignored without rendering designators',
    chunks: ['\x1b(Bhello\x1b)0world'],
    expect: {
      contains: ['hello', 'world'],
      notContains: ['(B', ')0'],
    },
  },
  {
    name: 'split SCS across chunks',
    chunks: ['\x1b(', 'BOK'],
    expect: {
      contains: ['OK'],
      notContains: ['BOK'],
    },
  },
  {
    name: 'wide characters keep cursor state intact',
    chunks: ['한글A'],
    expect: {
      contains: ['한글A'],
      cursor: { row: 0, col: 5 },
    },
  },
  {
    name: 'CSI S scroll-up applies to current scroll region',
    chunks: ['\x1b[?1049h', '\x1b[1;1HL1', '\x1b[2;1HL2', '\x1b[3;1HL3', '\x1b[4;1HL4', '\x1b[5;1HL5', '\x1b[6;1HL6', '\x1b[1S'],
    expect: {
      lineStarts: [{ index: 0, text: 'L2' }],
    },
  },
  {
    name: 'CSI T scroll-down applies to current scroll region',
    chunks: ['\x1b[?1049h', '\x1b[1;1HL1', '\x1b[2;1HL2', '\x1b[3;1HL3', '\x1b[4;1HL4', '\x1b[5;1HL5', '\x1b[6;1HL6', '\x1b[1T'],
    expect: {
      lineStarts: [{ index: 1, text: 'L1' }],
    },
  },
  {
    name: 'short snapshots are not bottom-anchored',
    chunks: ['hello'],
    expect: {
      lineStarts: [{ index: 0, text: 'hello' }],
    },
  },
  {
    name: 'zwj emoji sequence is rendered as one glyph cluster',
    chunks: ['👨‍💻A'],
    expect: {
      contains: ['👨‍💻A'],
      cursor: { row: 0, col: 3 },
    },
  },
];

function getRenderedLines(screen: VtScreen, cols: number, rows: number): { lines: string[]; text: string; cursorRow: number; cursorCol: number; cursorVisible: boolean } {
  const frame = screen.snapshot(cols, rows);
  const lines = frame.lines.map((line) => line.segments.map((seg) => seg.text).join('').replace(/\s+$/g, ''));
  return {
    lines,
    text: lines.join('\n'),
    cursorRow: frame.cursorRow,
    cursorCol: frame.cursorCol,
    cursorVisible: frame.cursorVisible,
  };
}

describe('VtScreen fixtures', () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const cols = fixture.cols ?? 20;
      const rows = fixture.rows ?? 6;
      const screen = new VtScreen(cols, rows);
      for (const chunk of fixture.chunks) {
        screen.write(chunk);
      }

      const rendered = getRenderedLines(screen, cols, rows);

      if (fixture.expect.cursor) {
        expect(rendered.cursorRow).toBe(fixture.expect.cursor.row);
        expect(rendered.cursorCol).toBe(fixture.expect.cursor.col);
      }
      if (fixture.expect.cursorVisible !== undefined) {
        expect(rendered.cursorVisible).toBe(fixture.expect.cursorVisible);
      }
      for (const assertion of fixture.expect.lineStarts || []) {
        expect(rendered.lines[assertion.index]?.startsWith(assertion.text)).toBe(true);
      }
      for (const assertion of fixture.expect.lineEquals || []) {
        expect(rendered.lines[assertion.index]).toBe(assertion.text);
      }
      for (const prefix of fixture.expect.anyLineStarts || []) {
        expect(rendered.lines.some((line) => line.startsWith(prefix))).toBe(true);
      }
      for (const text of fixture.expect.contains || []) {
        expect(rendered.text.includes(text)).toBe(true);
      }
      for (const text of fixture.expect.notContains || []) {
        expect(rendered.text.includes(text)).toBe(false);
      }
    });
  }
});
