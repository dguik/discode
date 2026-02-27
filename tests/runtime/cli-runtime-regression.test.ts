import { describe, expect, it } from 'vitest';
import { PtyRuntime } from '../../src/runtime/pty-runtime.js';
import { VtScreen } from '../../src/runtime/vt-screen.js';
import { buildTerminalResponse } from '../../src/runtime/pty-query-handler.js';

type QueryRecord = {
  screen: VtScreen;
  queryCarry: string;
  privateModes: Map<number, boolean>;
};

function createQueryRecord(cols = 80, rows = 24): QueryRecord {
  return {
    screen: new VtScreen(cols, rows),
    queryCarry: '',
    privateModes: new Map<number, boolean>(),
  };
}

function runQueryChunks(_runtime: PtyRuntime, record: QueryRecord, chunks: string[]): string {
  let response = '';
  for (const chunk of chunks) {
    response += buildTerminalResponse(record, chunk);
  }
  return response;
}

describe('PtyRuntime CLI regression suites', () => {
  it('covers Claude-style redraw and cursor/private queries', () => {
    const runtime = new PtyRuntime({ useNodePty: false });
    const record = createQueryRecord(80, 24);

    record.screen.write('claude> draft');
    record.screen.write('\r\x1b[2Kclaude> final');
    record.screen.write('\x1b[3G');

    const response = runQueryChunks(runtime, record, ['\x1b[', '?25$p\x1b[6n']);

    expect(response).toContain('\x1b[?25;1$y');
    expect(response).toContain('\x1b[1;3R');
    expect(record.queryCarry).toBe('');

    const frame = record.screen.snapshot(80, 24);
    const line0 = frame.lines[0].segments.map((seg) => seg.text).join('');
    expect(line0.startsWith('claude> final')).toBe(true);
  });

  it('covers OpenCode-style capability probes and OSC queries', () => {
    const runtime = new PtyRuntime({ useNodePty: false });
    const record = createQueryRecord(100, 30);

    const response = runQueryChunks(runtime, record, [
      '\x1b]10;?',
      '\x07\x1b]11;?\x07\x1b]4;12;?\x07\x1b[?u\x1b[14t',
    ]);

    expect(response).toContain('\x1b]10;rgb:e5e5/e5e5/e5e5\x07');
    expect(response).toContain('\x1b]11;rgb:0a0a/0a0a/0a0a\x07');
    expect(response).toMatch(/\x1b\]4;12;rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}\x07/);
    expect(response).toContain('\x1b[?0u');
    expect(response).toContain('\x1b[4;660;1100t');
    expect(record.queryCarry).toBe('');
  });

  it('covers Codex-style mode negotiation, DA, and kitty graphics handshake', () => {
    const runtime = new PtyRuntime({ useNodePty: false });
    const record = createQueryRecord(80, 24);

    const response = runQueryChunks(runtime, record, [
      '\x1b[?2004h\x1b[?2004$p\x1b[c\x1b_',
      'a=q\x1b\\',
    ]);

    expect(response).toContain('\x1b[?2004;1$y');
    expect(response).toContain('\x1b[?62;c');
    expect(response).toContain('\x1b_Gi=31337;OK\x1b\\');
    expect(record.queryCarry).toBe('');
  });
});
