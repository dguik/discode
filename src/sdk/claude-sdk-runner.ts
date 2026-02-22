/**
 * Claude Agent SDK runner — in-process alternative to tmux + hook scripts.
 *
 * Wraps the `query()` function from @anthropic-ai/claude-agent-sdk and maps
 * its streaming events to the same bridge event payloads that the hook scripts
 * produce, allowing the existing BridgeHookServer to handle them transparently.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk';

export interface SdkRunnerDeps {
  projectName: string;
  instanceId: string;
  agentType: string;
  projectPath: string;
  model?: string;
  permissionAllow: boolean;
  onEvent: (payload: Record<string, unknown>) => Promise<boolean>;
}

export class ClaudeSdkRunner {
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
  private running = false;

  constructor(private deps: SdkRunnerDeps) {}

  getSessionId(): string | null {
    return this.sessionId;
  }

  isRunning(): boolean {
    return this.running;
  }

  async submitMessage(prompt: string): Promise<void> {
    if (this.running) {
      console.warn(`[sdk-runner] ${this.deps.instanceId}: already running, ignoring message`);
      return;
    }

    this.running = true;
    this.abortController = new AbortController();

    try {
      const options: Record<string, unknown> = {
        cwd: this.deps.projectPath,
        abortController: this.abortController,
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['project'],
      };

      if (this.deps.model) {
        options.model = this.deps.model;
      }

      if (this.deps.permissionAllow) {
        options.permissionMode = 'bypassPermissions';
        options.allowDangerouslySkipPermissions = true;
      } else {
        options.permissionMode = 'acceptEdits';
      }

      if (this.sessionId) {
        options.resume = this.sessionId;
      }

      const q = query({ prompt, options: options as any });
      await this.processStream(q);
    } catch (error) {
      // Don't emit error for abort
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[sdk-runner] ${this.deps.instanceId}: query error:`, message);
      await this.emitEvent('session.error', { text: `SDK query failed: ${message}` });
    } finally {
      this.running = false;
      this.abortController = null;
    }
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  dispose(): void {
    this.abort();
    this.sessionId = null;
  }

  private async processStream(q: AsyncIterable<SDKMessage>): Promise<void> {
    let accumulatedText = '';
    let accumulatedThinking = '';
    const intermediateTextParts: string[] = [];

    // Track tool blocks for formatting
    const toolBlocks = new Map<number, { name: string; inputJson: string }>();

    // Text preview tracking
    let lastPreviewLen = 0;
    const PREVIEW_FIRST_THRESHOLD = 100;
    const PREVIEW_INTERVAL = 500;

    // Track whether we're accumulating text before a tool call
    let hasToolCalls = false;

    for await (const message of q) {
      if (message.type === 'system' && message.subtype === 'init') {
        this.sessionId = message.session_id;
        await this.emitEvent('session.start', {
          source: 'sdk',
          model: (message as any).model || '',
        });
        continue;
      }

      if (message.type === 'stream_event') {
        await this.handleStreamEvent(message as SDKPartialAssistantMessage, {
          accumulatedText: () => accumulatedText,
          addText: (t: string) => { accumulatedText += t; },
          resetText: () => { accumulatedText = ''; },
          accumulatedThinking: () => accumulatedThinking,
          addThinking: (t: string) => { accumulatedThinking += t; },
          intermediateTextParts,
          toolBlocks,
          lastPreviewLen: () => lastPreviewLen,
          setLastPreviewLen: (n: number) => { lastPreviewLen = n; },
          hasToolCalls: () => hasToolCalls,
          setHasToolCalls: () => { hasToolCalls = true; },
          PREVIEW_FIRST_THRESHOLD,
          PREVIEW_INTERVAL,
        });
        continue;
      }

      if (message.type === 'result') {
        const result = message as any;
        if (result.subtype === 'success') {
          const displayText = result.result || accumulatedText;
          const usage = result.usage
            ? {
                inputTokens: result.usage.input_tokens ?? 0,
                outputTokens: result.usage.output_tokens ?? 0,
                totalCostUsd: result.total_cost_usd ?? 0,
              }
            : undefined;

          await this.emitEvent('session.idle', {
            text: displayText,
            intermediateText: intermediateTextParts.join('\n\n'),
            thinking: accumulatedThinking,
            usage,
          });
        } else {
          // Error result
          const errors = Array.isArray(result.errors) ? result.errors.join('; ') : result.subtype;
          await this.emitEvent('session.error', { text: errors });
        }
        continue;
      }

      // SDKAssistantMessage — full message (non-streaming), extract text blocks
      if (message.type === 'assistant') {
        const content = (message as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              accumulatedText += block.text;
            }
          }
        }
      }
    }
  }

  private async handleStreamEvent(
    message: SDKPartialAssistantMessage,
    ctx: {
      accumulatedText: () => string;
      addText: (t: string) => void;
      resetText: () => void;
      accumulatedThinking: () => string;
      addThinking: (t: string) => void;
      intermediateTextParts: string[];
      toolBlocks: Map<number, { name: string; inputJson: string }>;
      lastPreviewLen: () => number;
      setLastPreviewLen: (n: number) => void;
      hasToolCalls: () => boolean;
      setHasToolCalls: () => void;
      PREVIEW_FIRST_THRESHOLD: number;
      PREVIEW_INTERVAL: number;
    },
  ): Promise<void> {
    const event = message.event as any;
    if (!event || !event.type) return;

    switch (event.type) {
      case 'content_block_start': {
        const block = event.content_block;
        if (!block) break;

        if (block.type === 'thinking') {
          await this.emitEvent('thinking.start', {});
          await this.emitEvent('tool.activity', { text: '\uD83E\uDDE0 Thinking...' });
        } else if (block.type === 'tool_use') {
          ctx.setHasToolCalls();
          // Save current accumulated text as intermediate text
          const currentText = ctx.accumulatedText();
          if (currentText.trim()) {
            ctx.intermediateTextParts.push(currentText.trim());
            ctx.resetText();
          }
          ctx.toolBlocks.set(event.index, { name: block.name || '', inputJson: '' });
          const toolName = block.name || 'unknown';
          await this.emitEvent('tool.activity', { text: `\uD83D\uDD27 Running: ${toolName}...` });
        }
        break;
      }

      case 'content_block_delta': {
        const delta = event.delta;
        if (!delta) break;

        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          ctx.addText(delta.text);
          // Emit text preview at intervals
          const textLen = ctx.accumulatedText().length;
          const lastLen = ctx.lastPreviewLen();
          if (
            (lastLen === 0 && textLen >= ctx.PREVIEW_FIRST_THRESHOLD) ||
            (lastLen > 0 && textLen - lastLen >= ctx.PREVIEW_INTERVAL)
          ) {
            ctx.setLastPreviewLen(textLen);
            const preview = this.truncate(ctx.accumulatedText().split('\n')[0], 80);
            await this.emitEvent('tool.activity', { text: `\uD83D\uDCAC "${preview}"` });
          }
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          ctx.addThinking(delta.thinking);
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const toolBlock = ctx.toolBlocks.get(event.index);
          if (toolBlock) {
            toolBlock.inputJson += delta.partial_json;
          }
        }
        break;
      }

      case 'content_block_stop': {
        const toolBlock = ctx.toolBlocks.get(event.index);
        if (toolBlock) {
          // Parse accumulated input JSON and format tool activity
          let toolInput: Record<string, unknown> = {};
          try {
            if (toolBlock.inputJson) {
              toolInput = JSON.parse(toolBlock.inputJson);
            }
          } catch {
            // Ignore parse errors
          }
          const formatted = this.formatToolActivity(toolBlock.name, toolInput);
          if (formatted) {
            await this.emitEvent('tool.activity', { text: formatted });
          }
          ctx.toolBlocks.delete(event.index);
        }

        // Check if this is a thinking block stop (heuristic: no tool block at this index)
        // The SDK doesn't give us the block type on stop, but thinking blocks won't have
        // a tool block entry. We check if thinking accumulated to determine.
        if (!toolBlock && ctx.accumulatedThinking().length > 0) {
          await this.emitEvent('thinking.stop', {});
        }
        break;
      }
    }
  }

  formatToolActivity(toolName: string, toolInput: Record<string, unknown>): string {
    switch (toolName) {
      case 'Read': {
        const fp = this.shortenPath(String(toolInput.file_path || ''));
        return `\uD83D\uDCD6 Read(\`${fp}\`)`;
      }
      case 'Edit': {
        const fp = this.shortenPath(String(toolInput.file_path || ''));
        const newStr = String(toolInput.new_string || '');
        const oldStr = String(toolInput.old_string || '');
        const delta = newStr.split('\n').length - oldStr.split('\n').length;
        const sign = delta >= 0 ? '+' : '';
        return `\u270F\uFE0F Edit(\`${fp}\`) ${sign}${delta} lines`;
      }
      case 'Write': {
        const fp = this.shortenPath(String(toolInput.file_path || ''));
        const content = String(toolInput.content || '');
        const lines = content.split('\n').length;
        return `\uD83D\uDCDD Write(\`${fp}\`) ${lines} lines`;
      }
      case 'Bash': {
        const cmd = this.truncate(String(toolInput.command || ''), 60);
        return `\uD83D\uDCBB \`${cmd}\``;
      }
      case 'Grep': {
        const pattern = this.truncate(String(toolInput.pattern || ''), 40);
        return `\uD83D\uDD0D Grep(\`${pattern}\`)`;
      }
      case 'Glob': {
        const pattern = this.truncate(String(toolInput.pattern || ''), 40);
        return `\uD83D\uDCC2 Glob(\`${pattern}\`)`;
      }
      case 'WebSearch': {
        const q = this.truncate(String(toolInput.query || ''), 40);
        return `\uD83C\uDF10 WebSearch(\`${q}\`)`;
      }
      case 'WebFetch': {
        const url = this.truncate(String(toolInput.url || ''), 40);
        return `\uD83C\uDF10 Fetch(\`${url}\`)`;
      }
      case 'Task': {
        const desc = this.truncate(String(toolInput.description || ''), 40);
        return `\uD83E\uDD16 Subagent: ${desc}`;
      }
      case 'AskUserQuestion': {
        return '';  // Handled via promptText
      }
      case 'ExitPlanMode': {
        return '';  // Handled via promptText
      }
      default: {
        // MCP tools or other built-in tools
        return `\uD83D\uDD0C ${toolName}`;
      }
    }
  }

  private shortenPath(fp: string, maxSegments = 3): string {
    if (!fp) return '';
    const parts = fp.split('/');
    if (parts.length <= maxSegments) return fp;
    return '.../' + parts.slice(-maxSegments).join('/');
  }

  private truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen - 1) + '\u2026';
  }

  private async emitEvent(
    eventType: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.onEvent({
        type: eventType,
        projectName: this.deps.projectName,
        agentType: this.deps.agentType,
        instanceId: this.deps.instanceId,
        ...extra,
      });
    } catch (error) {
      console.warn(`[sdk-runner] ${this.deps.instanceId}: emitEvent(${eventType}) failed:`, error);
    }
  }
}
