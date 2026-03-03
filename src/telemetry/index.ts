import { randomUUID } from 'crypto';
import { getConfigValue, saveConfig } from '../config/index.js';

const TELEMETRY_TIMEOUT_MS = 250;
const DEFAULT_TELEMETRY_ENDPOINT = 'https://telemetry.discode.chat/v1/events';
const TELEMETRY_EVENT_LIMIT = 10;

export interface CliCommandTelemetryEvent {
  command: string;
  success: boolean;
  durationMs: number;
  cliVersion: string;
}

export interface TelemetrySettings {
  enabled: boolean;
  endpoint?: string;
  installId?: string;
}

export interface DiscodeTelemetryEvent {
  name: string;
  params?: Record<string, string | number | boolean | null | undefined>;
}

export interface TelemetryMetadata {
  source?: string;
  version?: string;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return undefined;
}

function sanitizeCommand(command: string): string {
  const normalized = command.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  if (!normalized) return 'unknown';
  return normalized.slice(0, 40);
}

function sanitizeDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs)) return 0;
  const rounded = Math.max(0, Math.round(durationMs));
  return Math.min(rounded, 60_000_000);
}

function sanitizeNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.max(0, Math.round(value));
  return Math.min(rounded, 1_000_000_000);
}

function sanitizeString(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 100);
}

function sanitizeTelemetryEventName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!normalized) return 'cli_event';
  return normalized.slice(0, 40);
}

function sanitizeTelemetryParams(
  params: Record<string, string | number | boolean | null | undefined> | undefined,
): Record<string, string | number> {
  if (!params) return {};

  const sanitized: Record<string, string | number> = {};
  for (const [rawKey, rawValue] of Object.entries(params)) {
    const key = sanitizeTelemetryEventName(rawKey);
    if (!key) continue;
    if (rawValue === undefined || rawValue === null) continue;

    if (typeof rawValue === 'number') {
      sanitized[key] = sanitizeNumber(rawValue);
      continue;
    }

    if (typeof rawValue === 'boolean') {
      sanitized[key] = rawValue ? 1 : 0;
      continue;
    }

    const value = sanitizeString(rawValue);
    if (value !== undefined) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

function detectRuntime(): 'bun' | 'node' | 'unknown' {
  if (typeof globalThis !== 'undefined' && 'Bun' in globalThis) return 'bun';
  if (typeof process !== 'undefined' && process.release?.name === 'node') return 'node';
  return 'unknown';
}

export function isValidTelemetryEndpoint(urlValue: string): boolean {
  try {
    const parsed = new URL(urlValue);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function resolveTelemetrySettings(): TelemetrySettings {
  const storedEnabled = getConfigValue('telemetryEnabled');
  const envEnabled = parseBooleanEnv(process.env.DISCODE_TELEMETRY_ENABLED);
  const enabled = typeof storedEnabled === 'boolean' ? storedEnabled : envEnabled === true;

  const storedEndpoint = getConfigValue('telemetryEndpoint')?.trim();
  const envEndpoint = process.env.DISCODE_TELEMETRY_ENDPOINT?.trim();
  const endpoint = storedEndpoint || envEndpoint || DEFAULT_TELEMETRY_ENDPOINT;

  const storedInstallId = getConfigValue('telemetryInstallId')?.trim();
  const envInstallId = process.env.DISCODE_TELEMETRY_INSTALL_ID?.trim();
  const installId = storedInstallId || envInstallId || undefined;

  return { enabled, endpoint, installId };
}

export function ensureTelemetryInstallId(): string | undefined {
  const settings = resolveTelemetrySettings();
  if (settings.installId) return settings.installId;

  const generated = randomUUID();
  try {
    saveConfig({ telemetryInstallId: generated });
    return generated;
  } catch {
    return undefined;
  }
}

export async function recordTelemetryEvents(
  events: DiscodeTelemetryEvent[],
  metadata: TelemetryMetadata = {},
): Promise<void> {
  const settings = resolveTelemetrySettings();
  if (!settings.enabled || !settings.endpoint) return;
  if (!isValidTelemetryEndpoint(settings.endpoint)) return;
  if (!Array.isArray(events) || events.length === 0) return;

  const installId = settings.installId || ensureTelemetryInstallId();
  if (!installId) return;

  const sanitizedEvents = events
    .slice(0, TELEMETRY_EVENT_LIMIT)
    .map((event) => ({
      name: sanitizeTelemetryEventName(event.name || ''),
      params: sanitizeTelemetryParams(event.params),
    }));

  const body = {
    source: metadata.source || 'discode-cli',
    installId,
    version: metadata.version || process.env.DISCODE_VERSION || process.env.npm_package_version || 'unknown',
    platform: process.platform,
    runtime: detectRuntime(),
    events: sanitizedEvents,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
  try {
    await fetch(settings.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // Never break CLI flow because of telemetry.
  } finally {
    clearTimeout(timeout);
  }
}

export async function recordCliCommandTelemetry(event: CliCommandTelemetryEvent): Promise<void> {
  await recordTelemetryEvents(
    [
      {
        name: 'cli_command_run',
        params: {
          command: sanitizeCommand(event.command),
          success: event.success,
          duration_ms: sanitizeDuration(event.durationMs),
        },
      },
    ],
    { version: event.cliVersion },
  );
}
