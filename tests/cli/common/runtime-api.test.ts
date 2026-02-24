import { describe, expect, it } from 'vitest';
import { parseRuntimeWindowsResponse } from '../../../src/cli/common/runtime-api.js';

describe('parseRuntimeWindowsResponse', () => {
  it('returns null for invalid JSON', () => {
    expect(parseRuntimeWindowsResponse('not json')).toBeNull();
  });

  it('returns null when windows is not an array', () => {
    expect(parseRuntimeWindowsResponse('{"windows": "not-array"}')).toBeNull();
  });

  it('returns null when windows is missing', () => {
    expect(parseRuntimeWindowsResponse('{}')).toBeNull();
  });

  it('parses empty windows array', () => {
    const result = parseRuntimeWindowsResponse('{"windows": []}');
    expect(result).toEqual({ activeWindowId: undefined, windows: [] });
  });

  it('parses valid windows', () => {
    const json = JSON.stringify({
      activeWindowId: 'sess:win1',
      windows: [
        { windowId: 'sess:win1', sessionName: 'sess', windowName: 'win1', status: 'running', pid: 123 },
        { windowId: 'sess:win2', sessionName: 'sess', windowName: 'win2' },
      ],
    });
    const result = parseRuntimeWindowsResponse(json);
    expect(result).not.toBeNull();
    expect(result!.activeWindowId).toBe('sess:win1');
    expect(result!.windows).toHaveLength(2);
    expect(result!.windows[0]).toEqual({
      windowId: 'sess:win1',
      sessionName: 'sess',
      windowName: 'win1',
      status: 'running',
      pid: 123,
    });
    expect(result!.windows[1]).toEqual({
      windowId: 'sess:win2',
      sessionName: 'sess',
      windowName: 'win2',
      status: undefined,
      pid: undefined,
    });
  });

  it('filters out invalid window entries', () => {
    const json = JSON.stringify({
      windows: [
        { windowId: 'valid', sessionName: 'sess', windowName: 'win' },
        { windowId: 123, sessionName: 'sess', windowName: 'win' },
        null,
        'string',
        { sessionName: 'sess', windowName: 'win' },
        { windowId: 'id', windowName: 'win' },
        { windowId: 'id', sessionName: 'sess' },
      ],
    });
    const result = parseRuntimeWindowsResponse(json);
    expect(result!.windows).toHaveLength(1);
    expect(result!.windows[0].windowId).toBe('valid');
  });

  it('returns undefined activeWindowId when not a string', () => {
    const json = JSON.stringify({ activeWindowId: 123, windows: [] });
    const result = parseRuntimeWindowsResponse(json);
    expect(result!.activeWindowId).toBeUndefined();
  });

  it('handles extra fields gracefully', () => {
    const json = JSON.stringify({
      activeWindowId: 'a:b',
      windows: [{ windowId: 'a:b', sessionName: 'a', windowName: 'b', extra: 'ignored' }],
      otherField: true,
    });
    const result = parseRuntimeWindowsResponse(json);
    expect(result!.windows).toHaveLength(1);
    expect((result!.windows[0] as any).extra).toBeUndefined();
  });
});
