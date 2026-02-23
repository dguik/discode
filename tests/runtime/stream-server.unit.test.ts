import { describe, expect, it } from 'vitest';
import { RuntimeStreamServer } from '../../src/runtime/stream-server.js';
import type { AgentRuntime } from '../../src/runtime/interface.js';
import type { TerminalStyledFrame } from '../../src/runtime/vt-screen.js';

function createStyledFrame(cursorCol: number, cursorVisible: boolean = true): TerminalStyledFrame {
  return {
    cols: 10,
    rows: 4,
    cursorRow: 0,
    cursorCol,
    cursorVisible,
    lines: [
      { segments: [{ text: 'abc       ' }] },
      { segments: [{ text: '          ' }] },
      { segments: [{ text: '          ' }] },
      { segments: [{ text: '          ' }] },
    ],
  };
}

function createRuntimeMock(frameRef: { frame: TerminalStyledFrame; shouldThrowBuffer?: boolean }): AgentRuntime {
  return {
    getOrCreateSession: (projectName: string) => projectName,
    setSessionEnv: () => {},
    windowExists: () => true,
    startAgentInWindow: () => {},
    sendKeysToWindow: () => {},
    typeKeysToWindow: () => {},
    sendEnterToWindow: () => {},
    getWindowBuffer: () => {
      if (frameRef.shouldThrowBuffer) {
        throw new Error('buffer boom');
      }
      return 'abc';
    },
    getWindowFrame: () => frameRef.frame,
  };
}

function createPlainRuntime(buffer: string): AgentRuntime {
  return {
    getOrCreateSession: (projectName: string) => projectName,
    setSessionEnv: () => {},
    windowExists: () => true,
    startAgentInWindow: () => {},
    sendKeysToWindow: () => {},
    typeKeysToWindow: () => {},
    sendEnterToWindow: () => {},
    getWindowBuffer: () => buffer,
    getWindowFrame: undefined,
  };
}

function createRuntimeInputErrorMock(): AgentRuntime {
  return {
    getOrCreateSession: (projectName: string) => projectName,
    setSessionEnv: () => {},
    windowExists: () => true,
    startAgentInWindow: () => {},
    sendKeysToWindow: () => {},
    typeKeysToWindow: () => {
      throw new Error('window not running');
    },
    sendEnterToWindow: () => {},
    getWindowBuffer: () => 'abc',
    getWindowFrame: undefined,
  };
}

function createClientState(windowId: string = 'bridge:demo') {
  const writes: unknown[] = [];
  const socket = {
    write: (raw: string) => {
      for (const line of raw.trim().split('\n')) {
        if (line.length > 0) writes.push(JSON.parse(line));
      }
      return true;
    },
  };
  return {
    writes,
    client: {
      socket,
      buffer: '',
      windowId,
      cols: 120,
      rows: 40,
      seq: 0,
      lastBufferLength: -1,
      lastSnapshot: '',
      lastLines: [],
      lastEmitAt: 0,
      windowMissingNotified: false,
      runtimeErrorNotified: false,
      lastStyledSignature: '',
      lastStyledLines: [],
      lastCursorRow: -1,
      lastCursorCol: -1,
      lastCursorVisible: true,
    },
  };
}

describe('RuntimeStreamServer (unit flush behavior)', () => {
  it('emits styled frame when only cursor changes', () => {
    const frameRef = { frame: createStyledFrame(0) };
    const server = new RuntimeStreamServer(createRuntimeMock(frameRef), '/tmp/discode-stream-unit.sock', {
      minEmitIntervalMs: 250,
    });
    const { writes, client } = createClientState();

    (server as any).flushClientFrame(client, true);
    frameRef.frame = createStyledFrame(1);
    (server as any).flushClientFrame(client, true);

    const styledFrames = writes.filter(
      (payload: any) => payload && payload.type === 'frame-styled',
    ) as Array<{ seq: number; cursorCol: number }>;

    expect(styledFrames.length).toBe(2);
    expect(styledFrames[0].seq).toBe(1);
    expect(styledFrames[0].cursorCol).toBe(0);
    expect(styledFrames[1].seq).toBe(2);
    expect(styledFrames[1].cursorCol).toBe(1);
  });

  it('does not emit extra frame when styled content and cursor are unchanged', () => {
    const frameRef = { frame: createStyledFrame(0) };
    const server = new RuntimeStreamServer(createRuntimeMock(frameRef), '/tmp/discode-stream-unit-2.sock');
    const { writes, client } = createClientState();

    (server as any).flushClientFrame(client, true);
    (server as any).flushClientFrame(client, true);

    const styledFrames = writes.filter((payload: any) => payload?.type === 'frame-styled');
    expect(styledFrames.length).toBe(1);
  });

  it('emits styled frame when only cursor visibility changes', () => {
    const frameRef = { frame: createStyledFrame(0, true) };
    const server = new RuntimeStreamServer(createRuntimeMock(frameRef), '/tmp/discode-stream-unit-vis.sock');
    const { writes, client } = createClientState();

    (server as any).flushClientFrame(client, true);
    frameRef.frame = createStyledFrame(0, false);
    (server as any).flushClientFrame(client, true);

    const styledFrames = writes.filter((payload: any) => payload?.type === 'frame-styled');
    expect(styledFrames.length).toBe(2);
    expect((styledFrames[0] as any).cursorVisible).toBe(true);
    expect((styledFrames[1] as any).cursorVisible).toBe(false);
  });

  it('returns runtime_error once when buffer read fails', () => {
    const frameRef = { frame: createStyledFrame(0), shouldThrowBuffer: true };
    const server = new RuntimeStreamServer(createRuntimeMock(frameRef), '/tmp/discode-stream-unit-3.sock');
    const { writes, client } = createClientState();

    (server as any).flushClientFrame(client, true);
    (server as any).flushClientFrame(client, true);

    const errors = writes.filter((payload: any) => payload?.type === 'error');
    expect(errors.length).toBe(1);
    expect((errors[0] as any).code).toBe('runtime_error');
  });

  it('coalesces non-forced flush when interval is too short and buffer length is unchanged', () => {
    const server = new RuntimeStreamServer(createPlainRuntime('abc'), '/tmp/discode-stream-unit-4.sock', {
      minEmitIntervalMs: 250,
    });
    const { writes, client } = createClientState();
    client.lastBufferLength = 3;
    client.lastEmitAt = Date.now();
    client.lastSnapshot = 'abc';
    client.lastLines = ['abc'];

    (server as any).flushClientFrame(client, false);
    expect(writes.length).toBe(0);
  });

  it('bypasses coalescing when flush is forced', () => {
    const server = new RuntimeStreamServer(createPlainRuntime('abc'), '/tmp/discode-stream-unit-5.sock', {
      minEmitIntervalMs: 250,
    });
    const { writes, client } = createClientState();
    client.lastBufferLength = 3;
    client.lastEmitAt = Date.now();
    client.lastSnapshot = '';
    client.lastLines = [];

    (server as any).flushClientFrame(client, true);
    const frames = writes.filter((payload: any) => payload?.type === 'frame');
    expect(frames.length).toBe(1);
  });

  it('does not throw when runtime input path raises and emits window-exit', () => {
    const server = new RuntimeStreamServer(createRuntimeInputErrorMock(), '/tmp/discode-stream-unit-6.sock');
    const { writes, client } = createClientState('bridge:demo');

    (server as any).handleMessage(client, JSON.stringify({
      type: 'input',
      windowId: 'bridge:demo',
      bytesBase64: Buffer.from('x', 'utf8').toString('base64'),
    }));

    const exits = writes.filter((payload: any) => payload?.type === 'window-exit');
    expect(exits.length).toBe(1);
    expect((exits[0] as any).signal).toBe('not_running');
  });
});
