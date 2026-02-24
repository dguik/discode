/**
 * Individual event handlers for session lifecycle, thinking, tool activity, and idle.
 * Separated from pipeline/routing for change isolation:
 * - Text response changes don't affect file handling
 * - Thinking indicator changes don't affect response delivery
 */

import { existsSync, realpathSync } from 'fs';
import { splitForDiscord, splitForSlack, extractFilePaths, stripFilePaths } from '../capture/parser.js';
import type { MessagingClient } from '../messaging/interface.js';
import type { PendingMessageTracker } from './pending-message-tracker.js';
import type { PendingEntry } from './pending-message-tracker.js';
import type { StreamingMessageUpdater } from './streaming-message-updater.js';
import type { EventContext } from './hook-event-pipeline.js';
import {
  handleTaskProgress,
  handleGitActivity,
  handleSubagentDone,
  clearTaskChecklist,
} from './hook-structured-handlers.js';

export interface EventHandlerDeps {
  messaging: MessagingClient;
  pendingTracker: PendingMessageTracker;
  streamingUpdater: StreamingMessageUpdater;
  /** Periodic timers that show elapsed thinking time. */
  thinkingTimers: Map<string, { timer: ReturnType<typeof setInterval>; startTime: number }>;
  /** Thread activity messages (one per instance, replaced with latest activity). */
  threadActivityMessages: Map<string, { channelId: string; parentMessageId: string; messageId: string; lines: string[] }>;
  /** Session lifecycle timers. */
  sessionLifecycleTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Lazy start message creation + streaming updater start. */
  ensureStartMessageAndStreaming: (ctx: EventContext) => Promise<string | undefined>;
  clearThinkingTimer: (key: string) => void;
  clearSessionLifecycleTimer: (key: string) => void;
}

const THINKING_INTERVAL_MS = 10_000;
const SESSION_LIFECYCLE_DELAY_MS = 5_000;

export async function handleSessionError(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const k = `${ctx.projectName}:${ctx.instanceKey}`;
  deps.clearThinkingTimer(k);

  // Collect recent tool activity lines before clearing (error context for Slack users)
  const recentActivity = deps.threadActivityMessages.get(k);
  const recentLines = recentActivity?.lines.slice(-5) || [];

  deps.threadActivityMessages.delete(k);
  clearTaskChecklist(k);
  deps.streamingUpdater.discard(ctx.projectName, ctx.instanceKey);
  deps.pendingTracker.markError(ctx.projectName, ctx.agentType, ctx.instanceId).catch(() => {});
  const msg = ctx.text || 'unknown error';
  let errorMessage = `\u26A0\uFE0F OpenCode session error: ${msg}`;
  if (recentLines.length > 0) {
    errorMessage += '\n\n최근 활동:\n' + recentLines.join('\n');
  }
  await deps.messaging.sendToChannel(ctx.channelId, errorMessage);
  return true;
}

export async function handleSessionNotification(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const notificationType = typeof ctx.event.notificationType === 'string' ? ctx.event.notificationType : 'unknown';
  const emojiMap: Record<string, string> = {
    permission_prompt: '\uD83D\uDD10',
    idle_prompt: '\uD83D\uDCA4',
    auth_success: '\uD83D\uDD11',
    elicitation_dialog: '\u2753',
  };
  const emoji = emojiMap[notificationType] || '\uD83D\uDD14';
  const msg = ctx.text || notificationType;
  await deps.messaging.sendToChannel(ctx.channelId, `${emoji} ${msg}`);

  const promptText = typeof ctx.event.promptText === 'string' ? ctx.event.promptText.trim() : '';
  if (promptText) {
    await splitAndSendToChannel(deps.messaging, ctx.channelId, promptText);
  }
  return true;
}

export async function handleSessionStart(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const source = typeof ctx.event.source === 'string' ? ctx.event.source : 'unknown';
  if (source === 'startup') {
    return true;
  }
  const model = typeof ctx.event.model === 'string' ? ctx.event.model : '';
  const modelSuffix = model ? `, ${model}` : '';
  await deps.messaging.sendToChannel(ctx.channelId, `\u25B6\uFE0F Session started (${source}${modelSuffix})`);

  deps.pendingTracker.setHookActive(ctx.projectName, ctx.agentType, ctx.instanceId);

  const timerKey = `${ctx.projectName}:${ctx.instanceKey}`;
  deps.clearSessionLifecycleTimer(timerKey);
  const timer = setTimeout(() => {
    deps.sessionLifecycleTimers.delete(timerKey);
    if (
      deps.pendingTracker.hasPending(ctx.projectName, ctx.agentType, ctx.instanceId) &&
      !deps.pendingTracker.getPending(ctx.projectName, ctx.agentType, ctx.instanceId)?.startMessageId
    ) {
      deps.pendingTracker.markCompleted(ctx.projectName, ctx.agentType, ctx.instanceId).catch(() => {});
    }
  }, SESSION_LIFECYCLE_DELAY_MS);
  deps.sessionLifecycleTimers.set(timerKey, timer);

  return true;
}

export async function handleSessionEnd(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const reason = typeof ctx.event.reason === 'string' ? ctx.event.reason : 'unknown';
  await deps.messaging.sendToChannel(ctx.channelId, `\u23F9\uFE0F Session ended (${reason})`);
  deps.pendingTracker.setHookActive(ctx.projectName, ctx.agentType, ctx.instanceId);
  return true;
}

export async function handleThinkingStart(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  deps.clearSessionLifecycleTimer(`${ctx.projectName}:${ctx.instanceKey}`);
  await deps.ensureStartMessageAndStreaming(ctx);

  const pending = ctx.pendingSnapshot;
  if (pending?.messageId) {
    deps.messaging.addReactionToMessage(pending.channelId, pending.messageId, '\uD83E\uDDE0').catch(() => {});
  }

  const timerKey = `${ctx.projectName}:${ctx.instanceKey}`;
  deps.clearThinkingTimer(timerKey);
  const startTime = Date.now();
  deps.streamingUpdater.append(ctx.projectName, ctx.instanceKey, '\uD83E\uDDE0 Thinking\u2026');
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    deps.streamingUpdater.append(ctx.projectName, ctx.instanceKey, `\uD83E\uDDE0 Thinking\u2026 (${elapsed}s)`);
  }, THINKING_INTERVAL_MS);
  deps.thinkingTimers.set(timerKey, { timer, startTime });

  return true;
}

export async function handleThinkingStop(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const pending = ctx.pendingSnapshot;
  const timerKey = `${ctx.projectName}:${ctx.instanceKey}`;
  const entry = deps.thinkingTimers.get(timerKey);
  if (entry) {
    const elapsed = Math.round((Date.now() - entry.startTime) / 1000);
    if (elapsed >= 5) {
      deps.streamingUpdater.append(ctx.projectName, ctx.instanceKey, `\uD83E\uDDE0 Thought for ${elapsed}s`);
    }
  }
  deps.clearThinkingTimer(timerKey);

  if (pending?.messageId) {
    deps.messaging.replaceOwnReactionOnMessage(
      pending.channelId, pending.messageId, '\uD83E\uDDE0', '\u2705',
    ).catch(() => {});
  }
  return true;
}

export async function handleToolActivity(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  deps.clearSessionLifecycleTimer(`${ctx.projectName}:${ctx.instanceKey}`);
  await deps.ensureStartMessageAndStreaming(ctx);

  // Structured event prefixes — dispatch to specialized handlers
  if (ctx.text?.startsWith('TASK_CREATE:') || ctx.text?.startsWith('TASK_UPDATE:')) {
    return handleTaskProgress(deps, ctx);
  }
  if (ctx.text?.startsWith('GIT_COMMIT:') || ctx.text?.startsWith('GIT_PUSH:')) {
    return handleGitActivity(deps, ctx);
  }
  if (ctx.text?.startsWith('SUBAGENT_DONE:')) {
    return handleSubagentDone(deps, ctx);
  }

  const pending = ctx.pendingSnapshot;

  if (ctx.text && pending?.startMessageId) {
    const k = `${ctx.projectName}:${ctx.instanceKey}`;
    const existing = deps.threadActivityMessages.get(k);

    if (existing && existing.parentMessageId === pending.startMessageId) {
      existing.lines.push(ctx.text);
      try {
        await deps.messaging.updateMessage(existing.channelId, existing.messageId, existing.lines.join('\n'));
      } catch (error) {
        console.warn('Failed to update thread activity message:', error);
      }
    } else {
      try {
        const msgId = await deps.messaging.replyInThreadWithId(pending.channelId, pending.startMessageId, ctx.text);
        if (msgId) {
          deps.threadActivityMessages.set(k, {
            channelId: pending.channelId,
            parentMessageId: pending.startMessageId,
            messageId: msgId,
            lines: [ctx.text],
          });
        }
      } catch (error) {
        console.warn('Failed to post tool activity as thread reply:', error);
      }
    }
  }

  if (ctx.text) {
    deps.streamingUpdater.append(ctx.projectName, ctx.instanceKey, ctx.text);
  }

  return true;
}

export async function handleSessionIdle(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const idleKey = `${ctx.projectName}:${ctx.instanceKey}`;
  deps.clearThinkingTimer(idleKey);
  deps.clearSessionLifecycleTimer(idleKey);
  deps.threadActivityMessages.delete(idleKey);
  clearTaskChecklist(idleKey);

  const livePending = deps.pendingTracker.getPending(ctx.projectName, ctx.agentType, ctx.instanceId);
  const startMessageId = livePending?.startMessageId;

  const usage = ctx.event.usage as Record<string, unknown> | undefined;
  if (startMessageId) {
    const finalizeHeader = buildFinalizeHeader(usage);
    await deps.streamingUpdater.finalize(
      ctx.projectName, ctx.instanceKey,
      finalizeHeader || undefined,
      startMessageId,
    );
  }

  deps.pendingTracker.markCompleted(ctx.projectName, ctx.agentType, ctx.instanceId).catch(() => {});

  const pending: PendingEntry | undefined = startMessageId
    ? { channelId: ctx.channelId, messageId: ctx.pendingSnapshot?.messageId || '', startMessageId }
    : undefined;
  await postUsageAsThreadReply(deps.messaging, pending, usage);
  await postIntermediateTextAsThreadReply(deps.messaging, pending, ctx.event);
  await postThinkingAsThreadReply(deps.messaging, pending, ctx.event);

  // Main response: text + files (separated for change isolation)
  await postResponseText(deps.messaging, ctx);
  await postResponseFiles(deps.messaging, ctx);

  // Prompt choices (AskUserQuestion, ExitPlanMode)
  await postPromptChoices(deps.messaging, ctx);

  return true;
}

// ---------------------------------------------------------------------------
// session.idle sub-methods
// ---------------------------------------------------------------------------

function buildFinalizeHeader(usage: Record<string, unknown> | undefined): string | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
  const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
  const totalTokens = inputTokens + outputTokens;
  const totalCost = typeof usage.totalCostUsd === 'number' ? usage.totalCostUsd : 0;
  const parts: string[] = ['\u2705 Done'];
  if (totalTokens > 0) parts.push(`${totalTokens.toLocaleString()} tokens`);
  if (totalCost > 0) parts.push(`$${totalCost.toFixed(2)}`);
  return parts.join(' \u00B7 ');
}

async function postUsageAsThreadReply(
  messaging: MessagingClient,
  pending: PendingEntry | undefined,
  usage: Record<string, unknown> | undefined,
): Promise<void> {
  if (!usage || typeof usage !== 'object' || !pending?.startMessageId) return;
  const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
  const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
  const totalCost = typeof usage.totalCostUsd === 'number' ? usage.totalCostUsd : 0;
  if (inputTokens > 0 || outputTokens > 0) {
    const usageLine = `\uD83D\uDCCA Input: ${inputTokens.toLocaleString()} \u00B7 Output: ${outputTokens.toLocaleString()}${totalCost > 0 ? ` \u00B7 Cost: $${totalCost.toFixed(2)}` : ''}`;
    try {
      await messaging.replyInThread(pending.channelId, pending.startMessageId, usageLine);
    } catch { /* ignore usage reply failures */ }
  }
}

async function postIntermediateTextAsThreadReply(
  messaging: MessagingClient,
  pending: PendingEntry | undefined,
  event: Record<string, unknown>,
): Promise<void> {
  const intermediateText = typeof event.intermediateText === 'string' ? event.intermediateText.trim() : '';
  if (!intermediateText || !pending?.startMessageId) return;
  try {
    await splitAndSendAsThreadReply(messaging, pending.channelId, pending.startMessageId, intermediateText);
  } catch (error) {
    console.warn('Failed to post intermediate text as thread reply:', error);
  }
}

async function postThinkingAsThreadReply(
  messaging: MessagingClient,
  pending: PendingEntry | undefined,
  event: Record<string, unknown>,
): Promise<void> {
  const thinking = typeof event.thinking === 'string' ? event.thinking.trim() : '';
  if (!thinking || !pending?.startMessageId) return;
  try {
    const maxLen = 12000;
    let thinkingText = thinking.length > maxLen
      ? thinking.substring(0, maxLen) + '\n\n_(truncated)_'
      : thinking;
    thinkingText = `:brain: *Reasoning*\n\`\`\`\n${thinkingText}\n\`\`\``;
    await splitAndSendAsThreadReply(messaging, pending.channelId, pending.startMessageId, thinkingText);
  } catch (error) {
    console.warn('Failed to post thinking as thread reply:', error);
  }
}

/**
 * Send the text portion of the response. File paths are stripped from display text.
 */
async function postResponseText(messaging: MessagingClient, ctx: EventContext): Promise<void> {
  if (!ctx.text || ctx.text.trim().length === 0) return;

  const trimmed = ctx.text.trim();
  const turnText = typeof ctx.event.turnText === 'string' ? ctx.event.turnText.trim() : '';
  const fileSearchText = turnText || trimmed;
  const filePaths = validateFilePaths(extractFilePaths(fileSearchText), ctx.projectPath);

  const displayText = filePaths.length > 0 ? stripFilePaths(trimmed, filePaths) : trimmed;
  await splitAndSendToChannel(messaging, ctx.channelId, displayText);
}

/**
 * Send file attachments extracted from the response text.
 * Isolated from postResponseText so text changes don't affect file handling.
 */
async function postResponseFiles(messaging: MessagingClient, ctx: EventContext): Promise<void> {
  if (!ctx.text || ctx.text.trim().length === 0) return;

  const trimmed = ctx.text.trim();
  const turnText = typeof ctx.event.turnText === 'string' ? ctx.event.turnText.trim() : '';
  const fileSearchText = turnText || trimmed;
  const filePaths = validateFilePaths(extractFilePaths(fileSearchText), ctx.projectPath);

  if (filePaths.length > 0) {
    await messaging.sendToChannelWithFiles(ctx.channelId, '', filePaths);
  }
}

async function postPromptChoices(messaging: MessagingClient, ctx: EventContext): Promise<void> {
  const promptText = typeof ctx.event.promptText === 'string' ? ctx.event.promptText.trim() : '';
  if (!promptText) return;

  // Attach plan file if present (ExitPlanMode with plan content)
  const planFilePath = typeof ctx.event.planFilePath === 'string' ? ctx.event.planFilePath.trim() : '';
  if (planFilePath && existsSync(planFilePath)) {
    await messaging.sendToChannelWithFiles(ctx.channelId, promptText, [planFilePath]);
    return;
  }

  await splitAndSendToChannel(messaging, ctx.channelId, promptText);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function validateFilePaths(paths: string[], projectPath: string): string[] {
  if (!projectPath) return [];
  return paths.filter((p) => {
    if (!existsSync(p)) return false;
    try {
      const real = realpathSync(p);
      return real.startsWith(projectPath + '/') || real === projectPath;
    } catch {
      return false;
    }
  });
}

async function splitAndSendToChannel(messaging: MessagingClient, channelId: string, text: string): Promise<void> {
  const split = messaging.platform === 'slack' ? splitForSlack : splitForDiscord;
  const chunks = split(text);
  for (const chunk of chunks) {
    if (chunk.trim().length > 0) {
      await messaging.sendToChannel(channelId, chunk);
    }
  }
}

async function splitAndSendAsThreadReply(messaging: MessagingClient, channelId: string, messageId: string, text: string): Promise<void> {
  const split = messaging.platform === 'slack' ? splitForSlack : splitForDiscord;
  const chunks = split(text);
  for (const chunk of chunks) {
    if (chunk.trim().length > 0) {
      await messaging.replyInThread(channelId, messageId, chunk);
    }
  }
}
