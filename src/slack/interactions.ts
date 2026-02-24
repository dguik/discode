/**
 * Slack user interactions — approval requests, question buttons, polling.
 */

import type { App } from '@slack/bolt';
import type { MessageCallback } from '../messaging/interface.js';
import type { SlackChannels } from './channels.js';

export class SlackInteractions {
  constructor(
    private app: App,
    private botToken: string,
    private channels: SlackChannels,
  ) {}

  async sendApprovalRequest(
    channelId: string,
    toolName: string,
    toolInput: any,
    timeoutMs: number = 120000,
  ): Promise<boolean> {
    let inputPreview = '';
    if (toolInput) {
      const inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput, null, 2);
      inputPreview = inputStr.length > 500 ? inputStr.substring(0, 500) + '...' : inputStr;
    }

    const result = await this.app.client.chat.postMessage({
      token: this.botToken,
      channel: channelId,
      text: `Permission Request: Tool \`${toolName}\``,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:lock: *Permission Request*\nTool: \`${toolName}\`\n\`\`\`${inputPreview}\`\`\`\n_${Math.round(timeoutMs / 1000)}s timeout, auto-deny on timeout_`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Allow' },
              style: 'primary',
              action_id: 'approve_action',
              value: 'approve',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Deny' },
              style: 'danger',
              action_id: 'deny_action',
              value: 'deny',
            },
          ],
        },
      ],
    });

    const messageTs = result.ts;
    if (!messageTs) return false;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        this.app.client.chat.update({
          token: this.botToken,
          channel: channelId,
          ts: messageTs,
          text: `Permission Request: Tool \`${toolName}\` - Timed out`,
          blocks: [],
        }).catch(() => undefined);
        resolve(false);
      }, timeoutMs);

      const handler = async ({ action, ack, respond }: any) => {
        await ack();
        const approved = action.value === 'approve';
        cleanup();
        await respond({
          text: approved ? ':white_check_mark: *Allowed*' : ':x: *Denied*',
          replace_original: false,
        }).catch(() => undefined);
        resolve(approved);
      };

      const cleanup = () => {
        clearTimeout(timer);
      };

      this.app.action('approve_action', handler);
      this.app.action('deny_action', handler);
    });
  }

  async sendQuestionWithButtons(
    channelId: string,
    questions: Array<{
      question: string;
      header?: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>,
    timeoutMs: number = 300000,
  ): Promise<string | null> {
    const q = questions[0];
    if (!q) return null;

    const buttons = q.options.map((opt, i) => ({
      type: 'button' as const,
      text: { type: 'plain_text' as const, text: opt.label.slice(0, 75) },
      action_id: `opt_${i}`,
      value: opt.label,
      ...(i === 0 ? { style: 'primary' as const } : {}),
    }));

    const blocks: any[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:question: *${q.header || 'Question'}*\n${q.question}`,
        },
      },
    ];

    if (q.options.some((o) => o.description)) {
      blocks.push({
        type: 'section',
        fields: q.options.map((opt) => ({
          type: 'mrkdwn',
          text: `*${opt.label}*\n${opt.description || ' '}`,
        })),
      });
    }

    blocks.push({
      type: 'actions',
      elements: buttons,
    });

    const result = await this.app.client.chat.postMessage({
      token: this.botToken,
      channel: channelId,
      text: q.question,
      blocks,
    });

    const messageTs = result.ts;
    if (!messageTs) return null;

    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        this.app.client.chat.update({
          token: this.botToken,
          channel: channelId,
          ts: messageTs,
          text: `${q.question} - Timed out`,
          blocks: [],
        }).catch(() => undefined);
        resolve(null);
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
      };

      for (let i = 0; i < q.options.length; i++) {
        this.app.action(`opt_${i}`, async ({ action, ack }: any) => {
          await ack();
          cleanup();
          const selected = action.value || q.options[i].label;
          this.app.client.chat.update({
            token: this.botToken,
            channel: channelId,
            ts: messageTs,
            text: `${q.question} - Selected: ${selected}`,
            blocks: [],
          }).catch(() => undefined);
          resolve(selected);
        });
      }
    });
  }

  /**
   * Poll conversations.history for each mapped channel to catch messages
   * that the WebSocket may have dropped.
   */
  async pollMissedMessages(
    messageCallback: MessageCallback | undefined,
    handleIncomingMessage: (message: Record<string, any>) => Promise<void>,
  ): Promise<void> {
    if (!messageCallback) return;

    for (const [channelId] of this.channels.getChannelMapping()) {
      try {
        const oldest = this.channels.lastSeenTs.get(channelId);
        if (!oldest) continue;

        const result = await this.app.client.conversations.history({
          token: this.botToken,
          channel: channelId,
          oldest,
          limit: 20,
        });

        const messages = result.messages || [];
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i] as Record<string, any>;
          if (msg.ts === oldest) continue;
          await handleIncomingMessage({ ...msg, channel: channelId });
        }
      } catch (error) {
        console.warn(`Poll conversations.history failed for ${channelId}:`, error);
      }
    }
  }
}
