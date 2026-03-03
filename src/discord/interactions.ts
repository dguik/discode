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
import { randomUUID } from 'crypto';

export class DiscordInteractions {
  constructor(private client: Client) {}

  async sendApprovalRequest(
    channelId: string,
    toolName: string,
    toolInput: any,
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

    const embed = new EmbedBuilder()
      .setTitle('\uD83D\uDD12 Permission Request')
      .setDescription(`Tool: \`${toolName}\`\n\`\`\`\n${inputPreview}\n\`\`\``)
      .setColor(0xf0b232);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('approve')
        .setLabel('Allow')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('deny')
        .setLabel('Deny')
        .setStyle(ButtonStyle.Danger),
    );

    const message = await textChannel.send({
      embeds: [embed],
      components: [row],
    });

    const interaction = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => !i.user.bot,
    });

    const approved = interaction.customId === 'approve';
    await interaction.update({
      embeds: [embed
        .setColor(approved ? 0x57f287 : 0xed4245)
        .setFooter({ text: approved ? '\u2705 Allowed' : '\u274C Denied' })],
      components: [],
    });
    return approved;
  }

  async sendQuestionWithButtons(
    channelId: string,
    questions: Array<{
      question: string;
      header?: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>,
    _timeoutMs?: number,
    onAnswer?: (answer: string, optionIndex: number) => Promise<void>,
  ): Promise<string | null> {
    if (questions.length === 0) return null;

    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return null;
    const textChannel = channel as TextChannel;

    // Sequential: send each question one at a time
    const answers: string[] = [];
    for (const q of questions) {
      const result = await this.sendSingleQuestion(textChannel, q);
      answers.push(result.label);
      if (onAnswer) {
        await onAnswer(result.label, result.index);
      }
    }
    return answers.join('\n');
  }

  private async sendSingleQuestion(
    textChannel: TextChannel,
    q: { question: string; header?: string; options: Array<{ label: string; description?: string }> },
  ): Promise<{ label: string; index: number }> {
    const requestId = randomUUID().slice(0, 8);

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
          .setCustomId(`opt_${requestId}_${i}`)
          .setLabel(q.options[i].label.slice(0, 80))
          .setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary)
      );
    }
    rows.push(row);

    const message = await textChannel.send({
      embeds: [embed],
      components: rows,
    });

    const interaction = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => !i.user.bot,
    });

    const optIndex = parseInt(interaction.customId.split('_')[2]);
    const selected = q.options[optIndex]?.label || '';

    await interaction.update({
      embeds: [embed.setColor(0x57f287).setFooter({ text: `✅ ${selected}` })],
      components: [],
    });

    return { label: selected, index: optIndex };
  }

  async sendSubmitConfirmation(
    channelId: string,
    summary: Array<{ question: string; answer: string }>,
  ): Promise<boolean> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return false;
    const textChannel = channel as TextChannel;

    const embed = new EmbedBuilder()
      .setTitle('\uD83D\uDCCB Submit Answers')
      .setDescription(
        summary.map((s) => `**${s.question}**\n${s.answer}`).join('\n\n'),
      )
      .setColor(0x5865f2);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('submit')
        .setLabel('Submit')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger),
    );

    const message = await textChannel.send({
      embeds: [embed],
      components: [row],
    });

    const interaction = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => !i.user.bot,
    });

    const submitted = interaction.customId === 'submit';
    await interaction.update({
      embeds: [embed
        .setColor(submitted ? 0x57f287 : 0xed4245)
        .setFooter({ text: submitted ? '\u2705 Submitted' : '\u274C Cancelled' })],
      components: [],
    });
    return submitted;
  }
}
