/**
 * Structured tool activity handlers for prefix-based dispatch.
 *
 * These handlers process structured events encoded as prefixed strings
 * in the tool.activity text field (e.g., TASK_CREATE:, GIT_COMMIT:).
 * Separated from hook-event-handlers for change isolation.
 */

import type { EventHandlerDeps } from './hook-event-handlers.js';
import type { EventContext } from './hook-event-pipeline.js';

// ---------------------------------------------------------------------------
// Task checklist (TaskCreate / TaskUpdate)
// ---------------------------------------------------------------------------

/** Per-instance task checklist message, updated on each TaskCreate/TaskUpdate. */
const taskChecklistMessages = new Map<string, {
  channelId: string;
  messageId: string;
  tasks: Array<{ id: string; subject: string; status: string }>;
}>();

export function clearTaskChecklist(key: string): void {
  taskChecklistMessages.delete(key);
}

export async function handleTaskProgress(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  if (!ctx.text) return true;

  const k = `${ctx.projectName}:${ctx.instanceKey}`;
  let checklist = taskChecklistMessages.get(k);

  if (!checklist) {
    checklist = {
      channelId: ctx.channelId,
      messageId: '',
      tasks: [],
    };
    taskChecklistMessages.set(k, checklist);
  }

  try {
    if (ctx.text.startsWith('TASK_CREATE:')) {
      const data = JSON.parse(ctx.text.slice('TASK_CREATE:'.length));
      const nextId = String(checklist.tasks.length + 1);
      checklist.tasks.push({ id: nextId, subject: data.subject || '', status: 'pending' });
    } else if (ctx.text.startsWith('TASK_UPDATE:')) {
      const data = JSON.parse(ctx.text.slice('TASK_UPDATE:'.length));
      const task = checklist.tasks.find(t => t.id === data.taskId);
      if (task) {
        if (data.status) task.status = data.status;
        if (data.subject) task.subject = data.subject;
      }
    }
  } catch {
    return true;
  }

  const completedCount = checklist.tasks.filter(t => t.status === 'completed').length;
  const header = `\uD83D\uDCCB 작업 목록 (${completedCount}/${checklist.tasks.length} 완료)`;
  const lines = checklist.tasks.map(t => {
    const icon = t.status === 'completed' ? '\u2611\uFE0F' : t.status === 'in_progress' ? '\uD83D\uDD04' : '\u2B1C';
    return `${icon} #${t.id} ${t.subject}`;
  });
  const message = [header, ...lines].join('\n');

  try {
    if (checklist.messageId) {
      await deps.messaging.updateMessage(checklist.channelId, checklist.messageId, message);
    } else {
      const msgId = await deps.messaging.sendToChannelWithId(checklist.channelId, message);
      if (msgId) checklist.messageId = msgId;
    }
  } catch (error) {
    console.warn('Failed to update task checklist:', error);
  }

  deps.streamingUpdater.append(ctx.projectName, ctx.instanceKey, message);
  return true;
}

/** Mark a task as completed in the existing checklist (if any). */
export function markTaskCompletedInChecklist(
  deps: EventHandlerDeps,
  key: string,
  taskId: string,
): void {
  const checklist = taskChecklistMessages.get(key);
  if (!checklist) return;

  const task = checklist.tasks.find(t => t.id === taskId);
  if (!task || task.status === 'completed') return;

  task.status = 'completed';

  const completedCount = checklist.tasks.filter(t => t.status === 'completed').length;
  const header = `\uD83D\uDCCB 작업 목록 (${completedCount}/${checklist.tasks.length} 완료)`;
  const lines = checklist.tasks.map(t => {
    const icon = t.status === 'completed' ? '\u2611\uFE0F' : t.status === 'in_progress' ? '\uD83D\uDD04' : '\u2B1C';
    return `${icon} #${t.id} ${t.subject}`;
  });
  const message = [header, ...lines].join('\n');

  if (checklist.messageId) {
    deps.messaging.updateMessage(checklist.channelId, checklist.messageId, message).catch((error) => {
      console.warn('Failed to update task checklist from TaskCompleted:', error);
    });
  }
}

// ---------------------------------------------------------------------------
// Git activity (GIT_COMMIT / GIT_PUSH)
// ---------------------------------------------------------------------------

export async function handleGitActivity(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  if (!ctx.text) return true;

  let message = '';
  try {
    if (ctx.text.startsWith('GIT_COMMIT:')) {
      const data = JSON.parse(ctx.text.slice('GIT_COMMIT:'.length));
      message = `\uD83D\uDCE6 *Committed:* \`${data.message || ''}\``;
      if (data.stat) message += `\n   ${data.stat}`;
    } else if (ctx.text.startsWith('GIT_PUSH:')) {
      const data = JSON.parse(ctx.text.slice('GIT_PUSH:'.length));
      const hash = typeof data.toHash === 'string' ? data.toHash.slice(0, 7) : '';
      message = `\uD83D\uDE80 *Pushed to* \`${data.remoteRef || 'remote'}\` (\`${hash}\`)`;
    }
  } catch {
    return true;
  }

  if (!message) return true;

  try {
    await deps.messaging.sendToChannel(ctx.channelId, message);
  } catch (error) {
    console.warn('Failed to post git activity:', error);
  }

  deps.streamingUpdater.append(ctx.projectName, ctx.instanceKey, message);
  return true;
}

// ---------------------------------------------------------------------------
// Subagent completion (SUBAGENT_DONE)
// ---------------------------------------------------------------------------

export async function handleSubagentDone(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  if (!ctx.text) return true;

  let message = '';
  try {
    const data = JSON.parse(ctx.text.slice('SUBAGENT_DONE:'.length));
    const agentType = data.subagentType || 'agent';
    const summary = data.summary || '';
    if (!summary) return true;
    message = `\uD83D\uDD0D *${agentType} 완료:* ${summary}`;
  } catch {
    return true;
  }

  try {
    await deps.messaging.sendToChannel(ctx.channelId, message);
  } catch (error) {
    console.warn('Failed to post subagent completion:', error);
  }

  deps.streamingUpdater.append(ctx.projectName, ctx.instanceKey, message);
  return true;
}
