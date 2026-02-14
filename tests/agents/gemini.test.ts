import { GeminiAdapter } from '../../src/agents/gemini.js';
import { describe, expect, it } from 'vitest';

describe('GeminiAdapter', () => {
  it('should have correct config values', () => {
    const adapter = new GeminiAdapter();

    expect(adapter.config.name).toBe('gemini');
    expect(adapter.config.displayName).toBe('Gemini CLI');
    expect(adapter.config.command).toBe('gemini');
    expect(adapter.config.channelSuffix).toBe('gemini');
  });

  it('should return expected start command', () => {
    const adapter = new GeminiAdapter();

    const command = adapter.getStartCommand('/path/to/project');

    expect(command).toBe('cd "/path/to/project" && gemini');
  });
});
