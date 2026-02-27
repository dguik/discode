/**
 * Shared hook event contract types and helpers.
 *
 * This module defines the canonical event names accepted by the bridge and
 * provides lightweight runtime validation helpers for hook payloads.
 */

export const HOOK_EVENT_TYPES = [
  'session.error',
  'session.notification',
  'session.start',
  'session.end',
  'thinking.start',
  'thinking.stop',
  'tool.activity',
  'session.idle',
  'permission.request',
  'task.completed',
  'prompt.submit',
  'tool.failure',
  'teammate.idle',
] as const;

export type HookEventType = typeof HOOK_EVENT_TYPES[number];

export interface HookEventEnvelope extends Record<string, unknown> {
  type: string;
  projectName: string;
  agentType?: string;
  instanceId?: string;
  text?: string;
  message?: string;
  /** ISO timestamp recommended for producer-side tracing. */
  timestamp?: string;
  /** Producer turn identifier (optional, recommended). */
  turnId?: string;
}

export type HookCapabilityMap = Partial<Record<HookEventType, boolean>>;
export type NormalizedHookCapabilities = Record<HookEventType, boolean>;

export function isHookEventType(value: string): value is HookEventType {
  return (HOOK_EVENT_TYPES as readonly string[]).includes(value);
}

export function buildHookCapabilities(input?: HookCapabilityMap): NormalizedHookCapabilities {
  const out = {} as NormalizedHookCapabilities;
  for (const type of HOOK_EVENT_TYPES) {
    out[type] = input?.[type] === true;
  }
  return out;
}

export type HookEventValidationResult =
  | { ok: true; value: HookEventEnvelope }
  | { ok: false; errors: string[] };

/**
 * Validate the minimal shared envelope required by bridge handlers.
 * Event-specific fields are validated by dedicated handlers.
 */
export function validateHookEventEnvelope(payload: unknown): HookEventValidationResult {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, errors: ['payload must be an object'] };
  }

  const event = payload as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof event.type !== 'string' || event.type.trim().length === 0) {
    errors.push('type must be a non-empty string');
  }
  if (typeof event.projectName !== 'string' || event.projectName.trim().length === 0) {
    errors.push('projectName must be a non-empty string');
  }
  if (event.agentType !== undefined && typeof event.agentType !== 'string') {
    errors.push('agentType must be a string when provided');
  }
  if (event.instanceId !== undefined && typeof event.instanceId !== 'string') {
    errors.push('instanceId must be a string when provided');
  }
  if (event.text !== undefined && typeof event.text !== 'string') {
    errors.push('text must be a string when provided');
  }
  if (event.message !== undefined && typeof event.message !== 'string') {
    errors.push('message must be a string when provided');
  }
  if (event.timestamp !== undefined && typeof event.timestamp !== 'string') {
    errors.push('timestamp must be a string when provided');
  }
  if (event.turnId !== undefined && typeof event.turnId !== 'string') {
    errors.push('turnId must be a string when provided');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: event as HookEventEnvelope };
}

