import { describe, expect, it } from 'vitest';
import { applySgr } from '../../src/runtime/vt-sgr.js';

describe('applySgr', () => {
  it('resets to empty style with code 0', () => {
    const result = applySgr(['0'], { fg: '#fff', bold: true });
    expect(result).toEqual({});
  });

  it('resets with empty parts', () => {
    const result = applySgr([], { fg: '#fff' });
    expect(result).toEqual({});
  });

  it('sets bold with code 1', () => {
    expect(applySgr(['1'], {})).toEqual({ bold: true });
  });

  it('sets italic with code 3', () => {
    expect(applySgr(['3'], {})).toEqual({ italic: true });
  });

  it('sets underline with code 4', () => {
    expect(applySgr(['4'], {})).toEqual({ underline: true });
  });

  it('sets inverse with code 7', () => {
    expect(applySgr(['7'], {})).toEqual({ inverse: true });
  });

  it('clears bold with code 22', () => {
    expect(applySgr(['22'], { bold: true })).toEqual({ bold: false });
  });

  it('clears italic with code 23', () => {
    expect(applySgr(['23'], { italic: true })).toEqual({ italic: false });
  });

  it('clears underline with code 24', () => {
    expect(applySgr(['24'], { underline: true })).toEqual({ underline: false });
  });

  it('clears inverse with code 27', () => {
    expect(applySgr(['27'], { inverse: true })).toEqual({ inverse: false });
  });

  it('sets foreground ANSI color (30-37)', () => {
    const result = applySgr(['31'], {});
    expect(result.fg).toBe('#cd3131'); // red
  });

  it('sets background ANSI color (40-47)', () => {
    const result = applySgr(['42'], {});
    expect(result.bg).toBe('#0dbc79'); // green
  });

  it('sets bright foreground color (90-97)', () => {
    const result = applySgr(['91'], {});
    expect(result.fg).toBe('#f14c4c'); // bright red
  });

  it('sets bright background color (100-107)', () => {
    const result = applySgr(['101'], {});
    expect(result.bg).toBe('#f14c4c'); // bright red
  });

  it('resets fg with code 39', () => {
    expect(applySgr(['39'], { fg: '#ff0000' }).fg).toBeUndefined();
  });

  it('resets bg with code 49', () => {
    expect(applySgr(['49'], { bg: '#00ff00' }).bg).toBeUndefined();
  });

  it('handles 256-color foreground (38;5;n)', () => {
    const result = applySgr(['38', '5', '196'], {});
    expect(result.fg).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('handles 256-color background (48;5;n)', () => {
    const result = applySgr(['48', '5', '21'], {});
    expect(result.bg).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('handles RGB foreground (38;2;r;g;b)', () => {
    const result = applySgr(['38', '2', '255', '128', '0'], {});
    expect(result.fg).toBe('#ff8000');
  });

  it('handles RGB background (48;2;r;g;b)', () => {
    const result = applySgr(['48', '2', '0', '128', '255'], {});
    expect(result.bg).toBe('#0080ff');
  });

  it('handles multiple codes in sequence', () => {
    const result = applySgr(['1', '31', '42'], {});
    expect(result.bold).toBe(true);
    expect(result.fg).toBe('#cd3131');
    expect(result.bg).toBe('#0dbc79');
  });

  it('does not mutate input style', () => {
    const original = { fg: '#fff' };
    applySgr(['1'], original);
    expect(original).toEqual({ fg: '#fff' });
  });
});
