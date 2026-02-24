/**
 * Discord user interactions — approval requests, question buttons.
 */

import {
  TextChannel,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ComponentType,
  EmbedBuilder,
} from 'discord.js';
import type { Client } from 'discord.js';

export class DiscordInteractions {
  constructor(private client: Client) {}

  async sendApprovalRequest(
    channelId: string,
    toolName: string,
    toolInput: any,
    timeoutMs: number = 120000
  ): Promise<boolean> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      console.warn(`Channel ${channelId} is not a text channel, auto-denying`);
      return false;
    }

    const textChannel = channel as TextChannel;

    let inputPreview = '';
    if (toolInput) {
      const inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput, null, 2);
      inputPreview = inputStr.length > 500 ? inputStr.substring(0, 500) + '...' : inputStr;
    }

    const message = await textChannel.send(
      `🔒 **Permission Request**\n` +
      `Tool: \`${toolName}\`\n` +
      `\`\`\`\n${inputPreview}\n\`\`\`\n` +
      `React ✅ to allow, ❌ to deny (${Math.round(timeoutMs / 1000)}s timeout, auto-deny on timeout)`
    );

    await message.react('✅');
    await message.react('❌');

    try {
      const collected = await message.awaitReactions({
        filter: (reaction, user) =>
          ['✅', '❌'].includes(reaction.emoji.name || '') && !user.bot,
        max: 1,
        time: timeoutMs,
      });

      if (collected.size === 0) {
        await message.edit(message.content + '\n\n⏰ **Timed out — auto-denied**');
        return false;
      }

      const approved = collected.first()?.emoji.name === '✅';
      await message.edit(
        message.content + `\n\n${approved ? '✅ **Allowed**' : '❌ **Denied**'}`
      );
      return approved;
    } catch {
      await message.edit(message.content + '\n\n⚠️ **Error — auto-denied**').catch(() => {});
      return false;
    }
  }

  async sendQuestionWithButtons(
    channelId: string,
    questions: Array<{
      question: string;
      header?: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>,
    timeoutMs: number = 300000
  ): Promise<string | null> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return null;
    const textChannel = channel as TextChannel;

    const q = questions[0];
    if (!q) return null;

    const embed = new EmbedBuilder()
      .setTitle(`❓ ${q.header || 'Question'}`)
      .setDescription(q.question)
      .setColor(0x5865f2);

    if (q.options.some((o) => o.description)) {
      embed.addFields(
        q.options.map((opt) => ({
          name: opt.label,
          value: opt.description || '\u200b',
          inline: true,
        }))
      );
    }

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    let row = new ActionRowBuilder<ButtonBuilder>();

    for (let i = 0; i < q.options.length; i++) {
      if (i > 0 && i % 5 === 0) {
        rows.push(row);
        row = new ActionRowBuilder<ButtonBuilder>();
      }
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`opt_${i}`)
          .setLabel(q.options[i].label.slice(0, 80))
          .setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary)
      );
    }
    rows.push(row);

    const message = await textChannel.send({
      embeds: [embed],
      components: rows,
    });

    try {
      const interaction = await message.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => !i.user.bot,
        time: timeoutMs,
      });

      const optIndex = parseInt(interaction.customId.split('_')[1]);
      const selected = q.options[optIndex]?.label || '';

      await interaction.update({
        embeds: [embed.setColor(0x57f287).setFooter({ text: `✅ ${selected}` })],
        components: [],
      });

      return selected;
    } catch {
      await message
        .edit({
          embeds: [embed.setColor(0x95a5a6).setFooter({ text: '⏰ Timed out' })],
          components: [],
        })
        .catch(() => {});
      return null;
    }
  }
}
