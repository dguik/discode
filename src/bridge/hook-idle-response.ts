/**
 * Session idle response posting — text, files, usage, thinking, prompt choices.
 *
 * Extracted from hook-event-handlers.ts so that text delivery changes
 * don't affect file handling, and vice versa.
 */

import { existsSync, realpathSync } from 'fs';
import { splitForDiscord, splitForSlack, extractFilePaths, stripFilePaths } from '../capture/parser.js';
import type { MessagingClient } from '../messaging/interface.js';
import type { EventContext } from './hook-event-pipeline.js';

// ---------------------------------------------------------------------------
// Finalize header (usage summary for streaming updater)
// ---------------------------------------------------------------------------

export function buildFinalizeHeader(usage: Record<string, unknown> | undefined): string | undefined {
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

// ---------------------------------------------------------------------------
// Channel message sub-methods (usage, intermediate text, thinking)
// ---------------------------------------------------------------------------

export async function postUsageToChannel(
  messaging: MessagingClient,
  channelId: string,
  usage: Record<string, unknown> | undefined,
): Promise<void> {
  if (!usage || typeof usage !== 'object') return;
  const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
  const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
  const totalCost = typeof usage.totalCostUsd === 'number' ? usage.totalCostUsd : 0;
  if (inputTokens > 0 || outputTokens > 0) {
    const usageLine = `\uD83D\uDCCA *Usage:* Input: ${inputTokens.toLocaleString()} \u00B7 Output: ${outputTokens.toLocaleString()}${totalCost > 0 ? ` \u00B7 Cost: $${totalCost.toFixed(2)}` : ''}`;
    try {
      await messaging.sendToChannel(channelId, usageLine);
    } catch { /* ignore usage reply failures */ }
  }
}

export async function postIntermediateTextToChannel(
  messaging: MessagingClient,
  channelId: string,
  event: Record<string, unknown>,
): Promise<void> {
  const intermediateText = typeof event.intermediateText === 'string' ? event.intermediateText.trim() : '';
  if (!intermediateText) return;
  try {
    await splitAndSendToChannel(messaging, channelId, intermediateText);
  } catch (error) {
    console.warn('Failed to post intermediate text to channel:', error);
  }
}

export async function postThinkingToChannel(
  messaging: MessagingClient,
  channelId: string,
  event: Record<string, unknown>,
): Promise<void> {
  const thinking = typeof event.thinking === 'string' ? event.thinking.trim() : '';
  if (!thinking) return;
  try {
    const maxLen = 12000;
    let thinkingText = thinking.length > maxLen
      ? thinking.substring(0, maxLen) + '\n\n_(truncated)_'
      : thinking;
    thinkingText = `:brain: *Reasoning*\n\`\`\`\n${thinkingText}\n\`\`\``;
    await splitAndSendToChannel(messaging, channelId, thinkingText);
  } catch (error) {
    console.warn('Failed to post thinking to channel:', error);
  }
}

// ---------------------------------------------------------------------------
// Main response: text + files (separated for change isolation)
// ---------------------------------------------------------------------------

export async function postResponseText(messaging: MessagingClient, ctx: EventContext): Promise<void> {
  if (!ctx.text || ctx.text.trim().length === 0) return;

  const trimmed = ctx.text.trim();
  const turnText = typeof ctx.event.turnText === 'string' ? ctx.event.turnText.trim() : '';
  const fileSearchText = turnText || trimmed;
  const filePaths = validateFilePaths(extractFilePaths(fileSearchText), ctx.projectPath);

  const displayText = filePaths.length > 0 ? stripFilePaths(trimmed, filePaths) : trimmed;
  await splitAndSendToChannel(messaging, ctx.channelId, displayText);
}

export async function postResponseFiles(messaging: MessagingClient, ctx: EventContext): Promise<void> {
  if (!ctx.text || ctx.text.trim().length === 0) return;

  const trimmed = ctx.text.trim();
  const turnText = typeof ctx.event.turnText === 'string' ? ctx.event.turnText.trim() : '';
  const fileSearchText = turnText || trimmed;
  const filePaths = validateFilePaths(extractFilePaths(fileSearchText), ctx.projectPath);

  if (filePaths.length > 0) {
    await messaging.sendToChannelWithFiles(ctx.channelId, '', filePaths);
  }
}

export async function postPromptChoices(messaging: MessagingClient, ctx: EventContext): Promise<void> {
  // Structured questions (AskUserQuestion) → interactive buttons, fire-and-forget.
  // The button selection is routed back to Claude by SlackClient/DiscordClient.
  const rawQuestions = ctx.event.promptQuestions;
  if (Array.isArray(rawQuestions) && rawQuestions.length > 0) {
    const questions = rawQuestions.filter(
      (q): q is { question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean } =>
        typeof q === 'object' && q !== null &&
        typeof q.question === 'string' &&
        Array.isArray(q.options) && q.options.length > 0,
    );
    if (questions.length > 0) {
      // Don't await — this promise resolves when the user clicks a button (up to 5 min).
      // The client routes the selection back to Claude via messageCallback.
      messaging.sendQuestionWithButtons(ctx.channelId, questions).catch((err) => {
        console.warn('sendQuestionWithButtons failed:', err);
      });
      return;
    }
  }

  // Fallback: text-based prompt (ExitPlanMode or missing structured data)
  const promptText = typeof ctx.event.promptText === 'string' ? ctx.event.promptText.trim() : '';
  if (!promptText) return;

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

export function validateFilePaths(paths: string[], projectPath: string): string[] {
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

export async function splitAndSendToChannel(messaging: MessagingClient, channelId: string, text: string): Promise<void> {
  const split = messaging.platform === 'slack' ? splitForSlack : splitForDiscord;
  const chunks = split(text);
  for (const chunk of chunks) {
    if (chunk.trim().length > 0) {
      await messaging.sendToChannel(channelId, chunk);
    }
  }
}

