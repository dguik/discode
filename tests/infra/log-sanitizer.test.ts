import { describe, it, expect } from 'vitest';
import { truncateContent, maskToken, sanitizePath, sanitizeForLog } from '../../src/infra/log-sanitizer.js';
import { homedir } from 'os';

describe('truncateContent', () => {
  it('returns short strings as-is', () => {
    expect(truncateContent('hello')).toBe('hello');
  });

  it('truncates at default 50 chars', () => {
    const long = 'a'.repeat(100);
    const result = truncateContent(long);
    expect(result).toBe('a'.repeat(50) + '...');
  });

  it('truncates at custom length', () => {
    expect(truncateContent('hello world', 5)).toBe('hello...');
  });

  it('does not truncate at exact boundary', () => {
    expect(truncateContent('12345', 5)).toBe('12345');
  });
});

describe('maskToken', () => {
  it('masks xoxb- Slack bot tokens', () => {
    expect(maskToken('xoxb-1234-5678-abc')).toBe('xoxb-***');
  });

  it('masks xoxp- Slack user tokens', () => {
    expect(maskToken('xoxp-some-token-here')).toBe('xoxp-***');
  });

  it('masks Bearer tokens', () => {
    expect(maskToken('Bearer eyJhbGciOiJI...')).toBe('Bearer ***');
  });

  it('masks Bot prefix tokens', () => {
    expect(maskToken('Bot MTIzNDU2Nzg5')).toBe('Bot ***');
  });

  it('returns non-token strings unchanged', () => {
    expect(maskToken('regular-string')).toBe('regular-string');
  });
});

describe('sanitizePath', () => {
  it('replaces home directory with ~', () => {
    const home = homedir();
    expect(sanitizePath(`${home}/projects/test`)).toBe('~/projects/test');
  });

  it('replaces multiple occurrences', () => {
    const home = homedir();
    expect(sanitizePath(`${home}/a and ${home}/b`)).toBe('~/a and ~/b');
  });

  it('returns strings without home dir unchanged', () => {
    expect(sanitizePath('/tmp/foo')).toBe('/tmp/foo');
  });
});

describe('sanitizeForLog', () => {
  it('applies path sanitization', () => {
    const home = homedir();
    expect(sanitizeForLog(`file at ${home}/secret`)).toBe('file at ~/secret');
  });
});
