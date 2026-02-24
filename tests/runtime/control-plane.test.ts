import { describe, expect, it, vi } from 'vitest';
import { RuntimeControlPlane } from '../../src/runtime/control-plane.js';
import type { AgentRuntime } from '../../src/runtime/interface.js';

function createMockRuntime(
  windows: Array<{ sessionName: string; windowName: string; status?: string; pid?: number }> = [],
): AgentRuntime {
  return {
    getOrCreateSession: vi.fn(),
    setSessionEnv: vi.fn(),
    windowExists: vi.fn((session: string, window: string) =>
      windows.some((w) => w.sessionName === session && w.windowName === window),
    ),
    startAgentInWindow: vi.fn(),
    sendKeysToWindow: vi.fn(),
    typeKeysToWindow: vi.fn(),
    sendEnterToWindow: vi.fn(),
    listWindows: vi.fn(() => windows),
    getWindowBuffer: vi.fn((session: string, window: string) => `buffer-of-${session}:${window}`),
    stopWindow: vi.fn(() => true),
  };
}

describe('RuntimeControlPlane', () => {
  describe('isEnabled', () => {
    it('returns false when no runtime provided', () => {
      const cp = new RuntimeControlPlane(undefined);
      expect(cp.isEnabled()).toBe(false);
    });

    it('returns false when runtime lacks listWindows', () => {
      const rt = createMockRuntime();
      rt.listWindows = undefined;
      const cp = new RuntimeControlPlane(rt);
      expect(cp.isEnabled()).toBe(false);
    });

    it('returns false when runtime lacks getWindowBuffer', () => {
      const rt = createMockRuntime();
      rt.getWindowBuffer = undefined;
      const cp = new RuntimeControlPlane(rt);
      expect(cp.isEnabled()).toBe(false);
    });

    it('returns true when runtime has both listWindows and getWindowBuffer', () => {
      const rt = createMockRuntime();
      const cp = new RuntimeControlPlane(rt);
      expect(cp.isEnabled()).toBe(true);
    });
  });

  describe('listWindows', () => {
    it('returns empty list when no runtime', () => {
      const cp = new RuntimeControlPlane(undefined);
      const result = cp.listWindows();
      expect(result.windows).toEqual([]);
      expect(result.activeWindowId).toBeUndefined();
    });

    it('returns empty list when runtime lacks listWindows', () => {
      const rt = createMockRuntime();
      rt.listWindows = undefined;
      const cp = new RuntimeControlPlane(rt);
      expect(cp.listWindows().windows).toEqual([]);
    });

    it('returns windows with windowId format session:window', () => {
      const rt = createMockRuntime([{ sessionName: 'sess1', windowName: 'win1' }]);
      const cp = new RuntimeControlPlane(rt);
      const result = cp.listWindows();
      expect(result.windows).toHaveLength(1);
      expect(result.windows[0].windowId).toBe('sess1:win1');
    });

    it('auto-selects first window as activeWindowId', () => {
      const rt = createMockRuntime([
        { sessionName: 'sess1', windowName: 'win1' },
        { sessionName: 'sess1', windowName: 'win2' },
      ]);
      const cp = new RuntimeControlPlane(rt);
      const result = cp.listWindows();
      expect(result.activeWindowId).toBe('sess1:win1');
    });

    it('clears activeWindowId when windows become empty', () => {
      const windows = [{ sessionName: 'sess1', windowName: 'win1' }];
      const rt = createMockRuntime(windows);
      const cp = new RuntimeControlPlane(rt);

      cp.listWindows(); // sets active
      windows.length = 0; // clear windows
      const result = cp.listWindows();
      expect(result.activeWindowId).toBeUndefined();
    });

    it('resets activeWindowId when current active no longer exists', () => {
      const windows = [
        { sessionName: 'sess1', windowName: 'win1' },
        { sessionName: 'sess1', windowName: 'win2' },
      ];
      const rt = createMockRuntime(windows);
      const cp = new RuntimeControlPlane(rt);

      cp.focusWindow('sess1:win2');
      windows.splice(1, 1); // remove win2
      const result = cp.listWindows();
      expect(result.activeWindowId).toBe('sess1:win1');
    });
  });

  describe('focusWindow', () => {
    it('returns false when no runtime', () => {
      const cp = new RuntimeControlPlane(undefined);
      expect(cp.focusWindow('sess:win')).toBe(false);
    });

    it('returns false for invalid windowId format', () => {
      const rt = createMockRuntime([{ sessionName: 'sess1', windowName: 'win1' }]);
      const cp = new RuntimeControlPlane(rt);
      expect(cp.focusWindow('nocolon')).toBe(false);
      expect(cp.focusWindow(':noprefix')).toBe(false);
      expect(cp.focusWindow('nosuffix:')).toBe(false);
    });

    it('returns false for non-existent window', () => {
      const rt = createMockRuntime([{ sessionName: 'sess1', windowName: 'win1' }]);
      const cp = new RuntimeControlPlane(rt);
      expect(cp.focusWindow('sess1:nonexistent')).toBe(false);
    });

    it('returns true and sets activeWindowId for valid window', () => {
      const rt = createMockRuntime([
        { sessionName: 'sess1', windowName: 'win1' },
        { sessionName: 'sess1', windowName: 'win2' },
      ]);
      const cp = new RuntimeControlPlane(rt);

      expect(cp.focusWindow('sess1:win2')).toBe(true);
      expect(cp.getActiveWindowId()).toBe('sess1:win2');
    });
  });

  describe('sendInput', () => {
    it('throws when no runtime', () => {
      const cp = new RuntimeControlPlane(undefined);
      expect(() => cp.sendInput({ text: 'hello' })).toThrow('Runtime control unavailable');
    });

    it('throws when no windowId and no activeWindow', () => {
      const rt = createMockRuntime([{ sessionName: 'sess1', windowName: 'win1' }]);
      const cp = new RuntimeControlPlane(rt);
      expect(() => cp.sendInput({ text: 'hello' })).toThrow('Missing windowId');
    });

    it('throws for invalid windowId', () => {
      const rt = createMockRuntime([{ sessionName: 'sess1', windowName: 'win1' }]);
      const cp = new RuntimeControlPlane(rt);
      expect(() => cp.sendInput({ windowId: 'bad', text: 'hello' })).toThrow('Invalid windowId');
    });

    it('throws when window not found', () => {
      const rt = createMockRuntime([{ sessionName: 'sess1', windowName: 'win1' }]);
      const cp = new RuntimeControlPlane(rt);
      expect(() => cp.sendInput({ windowId: 'sess1:gone', text: 'hello' })).toThrow('Window not found');
    });

    it('sends text + enter by default', () => {
      const rt = createMockRuntime([{ sessionName: 'sess1', windowName: 'win1' }]);
      const cp = new RuntimeControlPlane(rt);

      cp.sendInput({ windowId: 'sess1:win1', text: 'hello' });
      expect(rt.typeKeysToWindow).toHaveBeenCalledWith('sess1', 'win1', 'hello');
      expect(rt.sendEnterToWindow).toHaveBeenCalledWith('sess1', 'win1');
    });

    it('sends only text when submit is false', () => {
      const rt = createMockRuntime([{ sessionName: 'sess1', windowName: 'win1' }]);
      const cp = new RuntimeControlPlane(rt);

      cp.sendInput({ windowId: 'sess1:win1', text: 'hello', submit: false });
      expect(rt.typeKeysToWindow).toHaveBeenCalledWith('sess1', 'win1', 'hello');
      expect(rt.sendEnterToWindow).not.toHaveBeenCalled();
    });

    it('sends only enter when text is empty', () => {
      const rt = createMockRuntime([{ sessionName: 'sess1', windowName: 'win1' }]);
      const cp = new RuntimeControlPlane(rt);

      cp.sendInput({ windowId: 'sess1:win1', text: '' });
      expect(rt.typeKeysToWindow).not.toHaveBeenCalled();
      expect(rt.sendEnterToWindow).toHaveBeenCalledWith('sess1', 'win1');
    });

    it('uses activeWindowId when no windowId provided', () => {
      const rt = createMockRuntime([{ sessionName: 'sess1', windowName: 'win1' }]);
      const cp = new RuntimeControlPlane(rt);

      cp.focusWindow('sess1:win1');
      const result = cp.sendInput({ text: 'hello' });
      expect(result.windowId).toBe('sess1:win1');
      expect(rt.typeKeysToWindow).toHaveBeenCalledWith('sess1', 'win1', 'hello');
    });

    it('updates activeWindowId after send', () => {
      const rt = createMockRuntime([
        { sessionName: 'sess1', windowName: 'win1' },
        { sessionName: 'sess1', windowName: 'win2' },
      ]);
      const cp = new RuntimeControlPlane(rt);

      cp.sendInput({ windowId: 'sess1:win2', text: 'hello' });
      expect(cp.getActiveWindowId()).toBe('sess1:win2');
    });
  });

  describe('getBuffer', () => {
    it('throws when runtime lacks getWindowBuffer', () => {
      const rt = createMockRuntime();
      rt.getWindowBuffer = undefined;
      const cp = new RuntimeControlPlane(rt);
      expect(() => cp.getBuffer('sess1:win1')).toThrow('Runtime control unavailable');
    });

    it('throws for invalid windowId', () => {
      const rt = createMockRuntime([{ sessionName: 'sess1', windowName: 'win1' }]);
      const cp = new RuntimeControlPlane(rt);
      expect(() => cp.getBuffer('bad')).toThrow('Invalid windowId');
    });

    it('throws when window not found', () => {
      const rt = createMockRuntime([{ sessionName: 'sess1', windowName: 'win1' }]);
      const cp = new RuntimeControlPlane(rt);
      expect(() => cp.getBuffer('sess1:gone')).toThrow('Window not found');
    });

    it('returns full buffer when since=0', () => {
      const rt = createMockRuntime([{ sessionName: 'sess1', windowName: 'win1' }]);
      const cp = new RuntimeControlPlane(rt);
      const result = cp.getBuffer('sess1:win1', 0);
      expect(result.chunk).toBe('buffer-of-sess1:win1');
      expect(result.since).toBe(0);
      expect(result.next).toBe('buffer-of-sess1:win1'.length);
    });

    it('returns partial buffer with since offset', () => {
      const rt = createMockRuntime([{ sessionName: 'sess1', windowName: 'win1' }]);
      const cp = new RuntimeControlPlane(rt);
      const result = cp.getBuffer('sess1:win1', 5);
      expect(result.chunk).toBe('buffer-of-sess1:win1'.slice(5));
      expect(result.since).toBe(5);
    });

    it('clamps since to buffer length', () => {
      const rt = createMockRuntime([{ sessionName: 'sess1', windowName: 'win1' }]);
      const cp = new RuntimeControlPlane(rt);
      const result = cp.getBuffer('sess1:win1', 99999);
      expect(result.chunk).toBe('');
      expect(result.since).toBe('buffer-of-sess1:win1'.length);
    });

    it('treats negative since as 0', () => {
      const rt = createMockRuntime([{ sessionName: 'sess1', windowName: 'win1' }]);
      const cp = new RuntimeControlPlane(rt);
      const result = cp.getBuffer('sess1:win1', -5);
      expect(result.since).toBe(0);
      expect(result.chunk).toBe('buffer-of-sess1:win1');
    });
  });

  describe('stopWindow', () => {
    it('throws when runtime lacks stopWindow', () => {
      const rt = createMockRuntime();
      rt.stopWindow = undefined;
      const cp = new RuntimeControlPlane(rt);
      expect(() => cp.stopWindow('sess1:win1')).toThrow('Runtime stop unavailable');
    });

    it('throws for invalid windowId', () => {
      const rt = createMockRuntime([{ sessionName: 'sess1', windowName: 'win1' }]);
      const cp = new RuntimeControlPlane(rt);
      expect(() => cp.stopWindow('bad')).toThrow('Invalid windowId');
    });

    it('throws when window not found', () => {
      const rt = createMockRuntime([{ sessionName: 'sess1', windowName: 'win1' }]);
      const cp = new RuntimeControlPlane(rt);
      expect(() => cp.stopWindow('sess1:gone')).toThrow('Window not found');
    });

    it('returns true when stop succeeds', () => {
      const rt = createMockRuntime([{ sessionName: 'sess1', windowName: 'win1' }]);
      const cp = new RuntimeControlPlane(rt);
      expect(cp.stopWindow('sess1:win1')).toBe(true);
      expect(rt.stopWindow).toHaveBeenCalledWith('sess1', 'win1');
    });

    it('throws when stopWindow returns false', () => {
      const rt = createMockRuntime([{ sessionName: 'sess1', windowName: 'win1' }]);
      (rt.stopWindow as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const cp = new RuntimeControlPlane(rt);
      expect(() => cp.stopWindow('sess1:win1')).toThrow('Failed to stop window');
    });
  });
});
