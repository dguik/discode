import { describe, expect, it } from 'vitest';
import { normalizeDiscordToken } from '../../src/config/token.js';

describe('normalizeDiscordToken', () => {
  it('returns empty string for undefined', () => {
    expect(normalizeDiscordToken(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(normalizeDiscordToken('')).toBe('');
  });

  it('returns empty string for whitespace-only string', () => {
    expect(normalizeDiscordToken('   ')).toBe('');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeDiscordToken('  abc123  ')).toBe('abc123');
  });

  it('removes surrounding double quotes', () => {
    expect(normalizeDiscordToken('"mytoken123"')).toBe('mytoken123');
  });

  it('removes surrounding single quotes', () => {
    expect(normalizeDiscordToken("'mytoken123'")).toBe('mytoken123');
  });

  it('removes Bot prefix (case insensitive)', () => {
    expect(normalizeDiscordToken('Bot abc123')).toBe('abc123');
    expect(normalizeDiscordToken('bot abc123')).toBe('abc123');
    expect(normalizeDiscordToken('BOT abc123')).toBe('abc123');
  });

  it('removes Bearer prefix (case insensitive)', () => {
    expect(normalizeDiscordToken('Bearer abc123')).toBe('abc123');
    expect(normalizeDiscordToken('bearer abc123')).toBe('abc123');
    expect(normalizeDiscordToken('BEARER abc123')).toBe('abc123');
  });

  it('removes internal whitespace', () => {
    expect(normalizeDiscordToken('abc 123 def')).toBe('abc123def');
  });

  it('handles combined: quoted + prefix + whitespace', () => {
    expect(normalizeDiscordToken('"Bot abc 123"')).toBe('abc123');
  });

  it('handles quoted whitespace-only value', () => {
    expect(normalizeDiscordToken('"  "')).toBe('');
  });

  it('passes through clean token unchanged', () => {
    const token = 'fake-test-token-value-not-real';
    expect(normalizeDiscordToken(token)).toBe(token);
  });
});
