/**
 * Discord channel management — creation, mapping, deletion, scanning.
 */

import { TextChannel, ChannelType } from 'discord.js';
import type { Client } from 'discord.js';
import type { AgentConfig, AgentRegistry } from '../agents/index.js';
import type { ChannelInfo } from '../messaging/interface.js';

export class DiscordChannels {
  readonly channelMapping: Map<string, ChannelInfo> = new Map();

  constructor(
    private client: Client,
    private registry: AgentRegistry,
  ) {}

  scanExistingChannels(): void {
    this.client.guilds.cache.forEach((guild) => {
      guild.channels.cache.forEach((channel) => {
        if (channel.isTextBased() && channel.name) {
          const parsed = this.parseChannelName(channel.name);
          if (parsed) {
            this.channelMapping.set(channel.id, parsed);
            console.log(`Mapped channel ${channel.name} (${channel.id}) -> ${parsed.projectName}:${parsed.agentType}`);
          }
        }
      });
    });
  }

  parseChannelName(channelName: string): ChannelInfo | null {
    const result = this.registry.parseChannelName(channelName);
    if (result) {
      return {
        projectName: result.projectName,
        agentType: result.agent.config.name,
      };
    }
    return null;
  }

  async createAgentChannels(
    guildId: string,
    projectName: string,
    agentConfigs: AgentConfig[],
    customChannelName?: string,
    instanceIdByAgent?: { [agentName: string]: string | undefined },
  ): Promise<{ [agentName: string]: string }> {
    const guild = await this.client.guilds.fetch(guildId);
    if (!guild) {
      throw new Error(`Guild ${guildId} not found`);
    }

    const result: { [agentName: string]: string } = {};

    const allChannels = await guild.channels.fetch();

    for (const config of agentConfigs) {
      const channelName = customChannelName || `${projectName}-${config.channelSuffix}`;
      const normalized = channelName.toLowerCase().replace(/\s+/g, '-');

      const existing = allChannels.find(
        (ch) => ch !== null && ch.type === ChannelType.GuildText && ch.name === normalized
      );

      let channel: TextChannel;
      let isNew = false;
      if (existing) {
        channel = existing as TextChannel;
        console.log(`  - ${config.displayName}: reusing existing channel ${channel.name} (${channel.id})`);
      } else {
        channel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          topic: `${config.displayName} agent for ${projectName}`,
        });
        isNew = true;
        console.log(`  - ${config.displayName}: created channel ${channel.name} (${channel.id})`);
      }

      this.channelMapping.set(channel.id, {
        projectName,
        agentType: config.name,
        instanceId: instanceIdByAgent?.[config.name],
      });

      if (isNew) {
        channel.send(
          `\uD83D\uDC4B **Welcome!** This channel is connected to the **${config.displayName}** agent for project **${projectName}**.\n` +
          `Send a message here to interact with the agent.`
        ).catch(() => {});
      }

      result[config.name] = channel.id;
    }

    console.log(`Set up ${agentConfigs.length} channels for project ${projectName}`);
    return result;
  }

  registerChannelMappings(mappings: { channelId: string; projectName: string; agentType: string; instanceId?: string }[]): void {
    for (const m of mappings) {
      this.channelMapping.set(m.channelId, {
        projectName: m.projectName,
        agentType: m.agentType,
        instanceId: m.instanceId,
      });
      console.log(
        `Registered channel ${m.channelId} -> ${m.projectName}:${m.agentType}${m.instanceId ? `#${m.instanceId}` : ''}`,
      );
    }
  }

  getChannelMapping(): Map<string, ChannelInfo> {
    return new Map(this.channelMapping);
  }

  async deleteChannel(channelId: string): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        await (channel as TextChannel).delete();
        this.channelMapping.delete(channelId);
        return true;
      }
      return false;
    } catch (error: any) {
      if (error?.code === 10003) {
        console.log(`Channel ${channelId} already deleted`);
      } else {
        console.error(`Failed to delete channel ${channelId}:`, error);
      }
      return false;
    }
  }

  getGuilds(): { id: string; name: string }[] {
    return this.client.guilds.cache.map((guild) => ({
      id: guild.id,
      name: guild.name,
    }));
  }
}
