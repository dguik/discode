import { describe, expect, it } from 'vitest';
import {
  HOOK_EVENT_TYPES,
  buildHookCapabilities,
  isHookEventType,
  validateHookEventEnvelope,
} from '../../src/types/hook-contract.js';

describe('hook-contract', () => {
  it('recognizes known hook event types', () => {
    for (const type of HOOK_EVENT_TYPES) {
      expect(isHookEventType(type)).toBe(true);
    }
    expect(isHookEventType('unknown.event')).toBe(false);
  });

  it('buildHookCapabilities defaults all events to false', () => {
    const capabilities = buildHookCapabilities();
    for (const type of HOOK_EVENT_TYPES) {
      expect(capabilities[type]).toBe(false);
    }
  });

  it('buildHookCapabilities applies explicit true flags only', () => {
    const capabilities = buildHookCapabilities({
      'session.idle': true,
      'prompt.submit': true,
    });
    expect(capabilities['session.idle']).toBe(true);
    expect(capabilities['prompt.submit']).toBe(true);
    expect(capabilities['tool.activity']).toBe(false);
  });

  it('validates minimal hook event envelope', () => {
    const result = validateHookEventEnvelope({
      type: 'session.idle',
      projectName: 'my-project',
      agentType: 'codex',
      instanceId: 'codex-1',
      text: 'done',
      timestamp: new Date().toISOString(),
      turnId: 'turn-1',
    });
    expect(result.ok).toBe(true);
  });

  it('returns errors for invalid envelope', () => {
    const result = validateHookEventEnvelope({
      type: '',
      projectName: 123,
      agentType: 456,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(expect.arrayContaining([
      'type must be a non-empty string',
      'projectName must be a non-empty string',
      'agentType must be a string when provided',
    ]));
  });
});
