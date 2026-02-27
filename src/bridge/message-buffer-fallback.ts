/**
 * Buffer fallback — polls tmux buffer for agent responses when hook events
 * are not available (e.g., agents without PostToolUse hooks).
 *
 * Extracted from BridgeMessageRouter for change isolation:
 * buffer polling logic doesn't affect message routing or shell execution.
 */

import { cleanCapture } from '../capture/parser.js';
import type { MessagingClient } from '../messaging/interface.js';
import type { AgentRuntime } from '../runtime/interface.js';
import type { PendingMessageTracker } from './pending-message-tracker.js';

export interface BufferFallbackDeps {
  messaging: MessagingClient;
  runtime: AgentRuntime;
  pendingTracker: PendingMessageTracker;
}

function getEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.trunc(n);
}

export function captureWindowText(runtime: AgentRuntime, sessionName: string, windowName: string): string | null {
  if (runtime.getWindowFrame) {
    try {
      const frame = runtime.getWindowFrame(sessionName, windowName);
      if (frame) {
        const lines = frame.lines.map((line) =>
          line.segments.map((s) => s.text).join(''),
        );
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
          lines.pop();
        }
        return lines.join('\n');
      }
    } catch {
      // fall through
    }
  }

  if (runtime.getWindowBuffer) {
    try {
      const buffer = runtime.getWindowBuffer(sessionName, windowName);
      if (!buffer) return null;
      return cleanCapture(buffer);
    } catch {
      return null;
    }
  }

  return null;
}

export function extractLastCommandBlock(text: string): string {
  const lines = text.split('\n');

  let lastPromptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^❯\s/.test(lines[i])) {
      lastPromptIdx = i;
      break;
    }
  }

  if (lastPromptIdx < 0) return text;

  const block = lines.slice(lastPromptIdx);
  while (block.length > 0 && block[block.length - 1].trim() === '') {
    block.pop();
  }

  if (isIdlePromptBlock(block)) {
    return '';
  }

  return block.join('\n');
}

export function isIdlePromptBlock(block: string[]): boolean {
  if (block.length === 0) return true;

  const isSeparator = (line: string) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return false;
    const chromeChars = trimmed.replace(/[─━─—–\-=═╌╍┄┅┈┉]/gu, '');
    return chromeChars.length === 0 || chromeChars.length / trimmed.length < 0.1;
  };

  let firstContentIdx = -1;
  for (let i = 1; i < block.length; i++) {
    if (block[i].trim().length > 0) {
      firstContentIdx = i;
      break;
    }
  }

  if (firstContentIdx < 0) return true;
  if (!isSeparator(block[firstContentIdx])) return false;

  let substantiveLines = 0;
  for (let i = firstContentIdx + 1; i < block.length; i++) {
    const trimmed = block[i].trim();
    if (trimmed.length === 0) continue;
    if (isSeparator(block[i])) continue;
    substantiveLines++;
  }

  return substantiveLines <= 2;
}

export function scheduleBufferFallback(
  deps: BufferFallbackDeps,
  fallbackTimers: Map<string, ReturnType<typeof setTimeout>>,
  sessionName: string,
  windowName: string,
  projectName: string,
  agentType: string,
  instanceKey: string,
  channelId: string,
): void {
  const key = `${projectName}:${instanceKey}`;

  const existing = fallbackTimers.get(key);
  if (existing) clearTimeout(existing);

  const initialDelayMs = getEnvInt('DISCODE_BUFFER_FALLBACK_INITIAL_MS', 3000);
  const stableCheckMs = getEnvInt('DISCODE_BUFFER_FALLBACK_STABLE_MS', 2000);
  const maxChecks = 3;

  let lastSnapshot = '';
  let checkCount = 0;

  const tag = `🖥️  [${key}]`;

  const check = async () => {
    fallbackTimers.delete(key);

    if (!deps.pendingTracker.hasPending(projectName, agentType, instanceKey)) {
      console.log(`${tag} fallback check #${checkCount}: pending already resolved, skipping`);
      return;
    }

    if (deps.pendingTracker.isHookActive(projectName, agentType, instanceKey)) {
      console.log(`${tag} fallback: hook events active, deferring to hook handler`);
      return;
    }

    const snapshot = captureWindowText(deps.runtime, sessionName, windowName);
    if (!snapshot) {
      console.log(`${tag} fallback check #${checkCount}: empty buffer, skipping`);
      return;
    }

    if (snapshot === lastSnapshot) {
      if (snapshot.trim().length > 0) {
        const relevant = extractLastCommandBlock(snapshot);
        if (relevant.trim().length === 0) {
          console.log(`${tag} fallback: buffer stable but idle prompt detected, skipping`);
          return;
        }
        console.log(`${tag} fallback: buffer stable (${snapshot.length} chars → ${relevant.length} chars), sending to channel`);
        try {
          await deps.messaging.sendToChannel(channelId, `\`\`\`\n${relevant}\n\`\`\``);
          await deps.pendingTracker.markCompleted(projectName, agentType, instanceKey);
        } catch (error) {
          console.warn(`${tag} fallback send failed:`, error);
          try {
            await deps.messaging.sendToChannel(channelId, 'Could not deliver agent output. Check logs for details.');
          } catch { /* ignore notification failure */ }
        }
      }
      return;
    }

    console.log(`${tag} fallback check #${checkCount}: buffer changed (${snapshot.length} chars), retrying`);
    lastSnapshot = snapshot;
    checkCount++;

    if (checkCount < maxChecks) {
      const timer = setTimeout(() => { check().catch(() => {}); }, stableCheckMs);
      fallbackTimers.set(key, timer);
    } else {
      console.log(`${tag} fallback: max checks reached, deferring to Stop hook`);
    }
  };

  const timer = setTimeout(() => { check().catch(() => {}); }, initialDelayMs);
  fallbackTimers.set(key, timer);
}
