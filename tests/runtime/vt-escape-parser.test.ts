import { describe, expect, it } from 'vitest';
import { parseVtStream, type VtParseAction } from '../../src/runtime/vt-escape-parser.js';

function collect(data: string): { actions: VtParseAction[]; carry: string } {
  const actions: VtParseAction[] = [];
  const carry = parseVtStream(data, (action) => actions.push(action));
  return { actions, carry };
}

describe('parseVtStream', () => {
  it('emits print actions for plain text', () => {
    const { actions, carry } = collect('abc');
    expect(carry).toBe('');
    expect(actions).toHaveLength(3);
    expect(actions[0]).toEqual({ type: 'print', ch: 'a', step: 1 });
    expect(actions[1]).toEqual({ type: 'print', ch: 'b', step: 1 });
    expect(actions[2]).toEqual({ type: 'print', ch: 'c', step: 1 });
  });

  it('emits cr for carriage return', () => {
    const { actions } = collect('\r');
    expect(actions).toEqual([{ type: 'cr' }]);
  });

  it('emits lf for line feed', () => {
    const { actions } = collect('\n');
    expect(actions).toEqual([{ type: 'lf' }]);
  });

  it('emits bs for backspace', () => {
    const { actions } = collect('\b');
    expect(actions).toEqual([{ type: 'bs' }]);
  });

  it('emits tab for tab character', () => {
    const { actions } = collect('\t');
    expect(actions).toEqual([{ type: 'tab' }]);
  });

  it('parses CSI sequences', () => {
    const { actions } = collect('\x1b[1;31m');
    expect(actions).toEqual([{ type: 'csi', raw: '1;31', final: 'm' }]);
  });

  it('parses CSI cursor movement', () => {
    const { actions } = collect('\x1b[5A');
    expect(actions).toEqual([{ type: 'csi', raw: '5', final: 'A' }]);
  });

  it('parses CSI with no parameters', () => {
    const { actions } = collect('\x1b[H');
    expect(actions).toEqual([{ type: 'csi', raw: '', final: 'H' }]);
  });

  it('handles ESC 7 as DECSC', () => {
    const { actions } = collect('\x1b7');
    expect(actions).toEqual([{ type: 'decsc' }]);
  });

  it('handles ESC 8 as DECRC', () => {
    const { actions } = collect('\x1b8');
    expect(actions).toEqual([{ type: 'decrc' }]);
  });

  it('handles ESC c as RIS', () => {
    const { actions } = collect('\x1bc');
    expect(actions).toEqual([{ type: 'ris' }]);
  });

  it('handles ESC D as index', () => {
    const { actions } = collect('\x1bD');
    expect(actions).toEqual([{ type: 'index' }]);
  });

  it('handles ESC E as next_line', () => {
    const { actions } = collect('\x1bE');
    expect(actions).toEqual([{ type: 'next_line' }]);
  });

  it('handles ESC M as reverse_index', () => {
    const { actions } = collect('\x1bM');
    expect(actions).toEqual([{ type: 'reverse_index' }]);
  });

  it('handles ESC = and ESC > as noop', () => {
    const { actions } = collect('\x1b=\x1b>');
    expect(actions).toEqual([{ type: 'noop' }, { type: 'noop' }]);
  });

  it('consumes character set designators (3 bytes)', () => {
    const { actions } = collect('\x1b(B');
    expect(actions).toEqual([{ type: 'noop' }]);
  });

  it('skips OSC sequences terminated by BEL', () => {
    const { actions } = collect('\x1b]0;title\x07abc');
    expect(actions).toHaveLength(3);
    expect(actions[0]).toEqual({ type: 'print', ch: 'a', step: 1 });
  });

  it('skips OSC sequences terminated by ST', () => {
    const { actions } = collect('\x1b]0;title\x1b\\abc');
    expect(actions).toHaveLength(3);
    expect(actions[0]).toEqual({ type: 'print', ch: 'a', step: 1 });
  });

  it('carries partial escape at end', () => {
    const { actions, carry } = collect('abc\x1b');
    expect(actions).toHaveLength(3);
    expect(carry).toBe('\x1b');
  });

  it('carries partial CSI at end', () => {
    const { actions, carry } = collect('abc\x1b[1;3');
    expect(actions).toHaveLength(3);
    expect(carry).toBe('\x1b[1;3');
  });

  it('carries partial OSC at end', () => {
    const { carry } = collect('\x1b]0;titl');
    expect(carry).toBe('\x1b]0;titl');
  });

  it('carries partial charset designator', () => {
    const { carry } = collect('\x1b(');
    expect(carry).toBe('\x1b(');
  });

  it('skips control characters below 0x20', () => {
    const { actions } = collect('\x01\x02\x03');
    expect(actions).toHaveLength(0);
  });

  it('skips DEL (0x7f)', () => {
    const { actions } = collect('\x7f');
    expect(actions).toHaveLength(0);
  });

  it('handles DCS sequences', () => {
    const { actions, carry } = collect('\x1bPtest\x1b\\abc');
    expect(carry).toBe('');
    expect(actions).toHaveLength(3); // just 'abc'
  });

  it('handles multi-codepoint characters', () => {
    const { actions } = collect('漢');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({ type: 'print', ch: '漢', step: 1 });
  });

  it('handles emoji (surrogate pair)', () => {
    const { actions } = collect('😀');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'print', ch: '😀' });
  });

  it('returns empty carry for complete input', () => {
    const { carry } = collect('hello\x1b[31mworld\x1b[0m');
    expect(carry).toBe('');
  });
});
