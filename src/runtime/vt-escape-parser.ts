/**
 * VT escape sequence tokenizer.
 *
 * Parses a stream of terminal data into discrete actions (CSI, print,
 * control characters, etc.) via a callback-based API.
 *
 * Returns any unconsumed trailing bytes (partial sequences) so the
 * caller can carry them into the next chunk.
 */

import { incRuntimeMetric } from './vt-diagnostics.js';

export type VtParseAction =
  | { type: 'print'; ch: string; step: number }
  | { type: 'csi'; raw: string; final: string }
  | { type: 'cr' }
  | { type: 'lf' }
  | { type: 'bs' }
  | { type: 'tab' }
  | { type: 'decsc' }
  | { type: 'decrc' }
  | { type: 'ris' }
  | { type: 'index' }
  | { type: 'next_line' }
  | { type: 'reverse_index' }
  | { type: 'noop' };

/**
 * Parse a VT data stream and emit discrete actions via the callback.
 *
 * @returns Unconsumed bytes (partial escape sequences) to carry forward.
 */
export function parseVtStream(data: string, emit: (action: VtParseAction) => void): string {
  let i = 0;

  while (i < data.length) {
    const cp = data.codePointAt(i);
    if (cp === undefined) break;
    const ch = String.fromCodePoint(cp);
    const step = ch.length;

    if (ch === '\x1b') {
      const next = data[i + 1];
      if (next === undefined) {
        incRuntimeMetric('vt_partial_sequence_carry', { kind: 'escape' });
        return data.slice(i);
      }

      if (next === '[') {
        let j = i + 2;
        while (j < data.length && (data.charCodeAt(j) < 0x40 || data.charCodeAt(j) > 0x7e)) j += 1;
        if (j >= data.length) {
          incRuntimeMetric('vt_partial_sequence_carry', { kind: 'csi' });
          return data.slice(i);
        }
        const final = data[j];
        const raw = data.slice(i + 2, j);
        emit({ type: 'csi', raw, final });
        i = j + 1;
        continue;
      }

      if (next === '7') {
        emit({ type: 'decsc' });
        i += 2;
        continue;
      }

      if (next === '8') {
        emit({ type: 'decrc' });
        i += 2;
        continue;
      }

      if (next === 'c') {
        emit({ type: 'ris' });
        i += 2;
        continue;
      }

      if (next === '=' || next === '>' || next === '\\') {
        emit({ type: 'noop' });
        i += 2;
        continue;
      }

      if (next === '(' || next === ')' || next === '*' || next === '+' || next === '-' || next === '.' || next === '/') {
        if (data[i + 2] === undefined) {
          incRuntimeMetric('vt_partial_sequence_carry', { kind: 'escape' });
          return data.slice(i);
        }
        emit({ type: 'noop' });
        i += 3;
        continue;
      }

      if (next === 'D') {
        emit({ type: 'index' });
        i += 2;
        continue;
      }

      if (next === 'E') {
        emit({ type: 'next_line' });
        i += 2;
        continue;
      }

      if (next === 'M') {
        emit({ type: 'reverse_index' });
        i += 2;
        continue;
      }

      if (next === ']') {
        // OSC
        let j = i + 2;
        let terminated = false;
        while (j < data.length) {
          if (data[j] === '\x07') {
            j += 1;
            terminated = true;
            break;
          }
          if (data[j] === '\x1b' && data[j + 1] === '\\') {
            j += 2;
            terminated = true;
            break;
          }
          j += 1;
        }
        if (!terminated) {
          incRuntimeMetric('vt_partial_sequence_carry', { kind: 'osc' });
          return data.slice(i);
        }
        i = j;
        continue;
      }

      if (next === 'P' || next === 'X' || next === '^' || next === '_') {
        // DCS/SOS/PM/APC - consume until ST.
        let j = i + 2;
        let terminated = false;
        while (j < data.length) {
          if (data[j] === '\x1b' && data[j + 1] === '\\') {
            j += 2;
            terminated = true;
            break;
          }
          j += 1;
        }
        if (!terminated) {
          incRuntimeMetric('vt_partial_sequence_carry', { kind: 'escape' });
          return data.slice(i);
        }
        i = j;
        continue;
      }

      incRuntimeMetric('vt_unknown_escape', { next });
      i += 2;
      continue;
    }

    if (ch === '\r') {
      emit({ type: 'cr' });
      i += step;
      continue;
    }

    if (ch === '\n') {
      emit({ type: 'lf' });
      i += step;
      continue;
    }

    if (ch === '\b') {
      emit({ type: 'bs' });
      i += step;
      continue;
    }

    if (ch === '\t') {
      emit({ type: 'tab' });
      i += step;
      continue;
    }

    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      i += step;
      continue;
    }

    emit({ type: 'print', ch, step });
    i += step;
  }

  return '';
}
