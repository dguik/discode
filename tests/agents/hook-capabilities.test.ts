import { describe, expect, it } from 'vitest';
import { HOOK_EVENT_TYPES, type HookEventType } from '../../src/types/hook-contract.js';
import { ClaudeAdapter } from '../../src/agents/claude/index.js';
import { CodexAdapter } from '../../src/agents/codex/index.js';
import { OpenCodeAdapter } from '../../src/agents/opencode/index.js';
import { GeminiAdapter } from '../../src/agents/gemini/index.js';

function expectCapabilities(adapter: { supportsHookEvent: (eventType: HookEventType) => boolean }, enabled: HookEventType[]): void {
  const expected = new Set(enabled);
  for (const eventType of HOOK_EVENT_TYPES) {
    expect(adapter.supportsHookEvent(eventType)).toBe(expected.has(eventType));
  }
}

describe('agent hook capabilities', () => {
  it('claude adapter exposes supported hook events', () => {
    expectCapabilities(new ClaudeAdapter(), [
      'session.notification',
      'session.start',
      'session.end',
      'tool.activity',
      'session.idle',
      'permission.request',
      'task.completed',
      'prompt.submit',
      'tool.failure',
      'teammate.idle',
    ]);
  });

  it('codex adapter exposes supported hook events', () => {
    expectCapabilities(new CodexAdapter(), [
      'tool.activity',
      'session.idle',
    ]);
  });

  it('opencode adapter exposes supported hook events', () => {
    expectCapabilities(new OpenCodeAdapter(), [
      'session.error',
      'session.notification',
      'session.start',
      'session.end',
      'session.idle',
    ]);
  });

  it('gemini adapter exposes supported hook events', () => {
    expectCapabilities(new GeminiAdapter(), [
      'session.notification',
      'session.start',
      'session.end',
      'session.idle',
    ]);
  });
});
