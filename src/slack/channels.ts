/**
 * Slack channel management — create, register, scan, delete.
 */

import type { App } from '@slack/bolt';
import type { AgentConfig } from '../agents/index.js';
import type { ChannelInfo } from '../messaging/interface.js';

export class SlackChannels {
  private channelMapping: Map<string, ChannelInfo> = new Map();
  /** Last processed message `ts` per channel, used by polling fallback. */
  lastSeenTs = new Map<string, string>();
  /** Workspaces resolved during connect(). */
  workspaces: { id: string; name: string }[] = [];

  constructor(private app: App, private botToken: string) {}

  getChannelMapping(): Map<string, ChannelInfo> {
    return new Map(this.channelMapping);
  }

  getChannelInfo(channelId: string): ChannelInfo | undefined {
    return this.channelMapping.get(channelId);
  }

  setChannelInfo(channelId: string, info: ChannelInfo): void {
    this.channelMapping.set(channelId, info);
  }

  getGuilds(): { id: string; name: string }[] {
    return this.workspaces;
  }

  async deleteChannel(channelId: string): Promise<boolean> {
    this.channelMapping.delete(channelId);
    return true;
  }

  registerChannelMappings(mappings: { channelId: string; projectName: string; agentType: string; instanceId?: string }[]): void {
    const nowTs = `${Math.floor(Date.now() / 1000)}.000000`;
    for (const m of mappings) {
      this.channelMapping.set(m.channelId, {
        projectName: m.projectName,
        agentType: m.agentType,
        instanceId: m.instanceId,
      });
      if (!this.lastSeenTs.has(m.channelId)) {
        this.lastSeenTs.set(m.channelId, nowTs);
      }
      console.log(
        `Registered Slack channel ${m.channelId} -> ${m.projectName}:${m.agentType}${m.instanceId ? `#${m.instanceId}` : ''}`,
      );
    }
  }

  async createAgentChannels(
    _guildId: string,
    projectName: string,
    agentConfigs: AgentConfig[],
    customChannelName?: string,
    instanceIdByAgent?: { [agentName: string]: string | undefined },
  ): Promise<{ [agentName: string]: string }> {
    const result: { [agentName: string]: string } = {};

    const channelsByName = new Map<string, string>();
    let cursor: string | undefined;
    do {
      const page = await this.app.client.conversations.list({
        token: this.botToken,
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      for (const ch of page.channels || []) {
        if (ch.name && ch.id) {
          channelsByName.set(ch.name, ch.id);
        }
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);

    for (const config of agentConfigs) {
      const channelName = customChannelName || `${projectName}-${config.channelSuffix}`;
      const normalized = channelName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '').slice(0, 80);

      let channelId = channelsByName.get(normalized);
      let isNew = false;
      if (channelId) {
        await this.app.client.conversations.join({
          token: this.botToken,
          channel: channelId,
        }).catch(() => undefined);
        console.log(`  - ${config.displayName}: reusing existing Slack channel #${normalized} (${channelId})`);
      } else {
        try {
          const created = await this.app.client.conversations.create({
            token: this.botToken,
            name: normalized,
          });
          channelId = created.channel?.id;
          if (channelId) {
            isNew = true;
            await this.app.client.conversations.setTopic({
              token: this.botToken,
              channel: channelId,
              topic: `${config.displayName} agent for ${projectName}`,
            }).catch(() => undefined);
            console.log(`  - ${config.displayName}: created Slack channel #${normalized} (${channelId})`);
          }
        } catch (error: any) {
          if (error?.data?.error === 'name_taken') {
            channelId = await this.findChannelByName(normalized);
            if (channelId) {
              await this.app.client.conversations.join({
                token: this.botToken,
                channel: channelId,
              }).catch(() => undefined);
              console.log(`  - ${config.displayName}: found and reusing Slack channel #${normalized} (${channelId})`);
            } else {
              console.warn(`  - ${config.displayName}: channel #${normalized} name is taken but could not locate it`);
              continue;
            }
          } else {
            throw error;
          }
        }
      }

      if (channelId) {
        this.channelMapping.set(channelId, {
          projectName,
          agentType: config.name,
          instanceId: instanceIdByAgent?.[config.name],
        });

        if (isNew) {
          this.app.client.chat.postMessage({
            token: this.botToken,
            channel: channelId,
            text: `\uD83D\uDC4B *Welcome!* This channel is connected to the *${config.displayName}* agent for project *${projectName}*.\nSend a message here to interact with the agent.`,
          }).catch(() => {});
        }

        result[config.name] = channelId;
      }
    }

    console.log(`Set up ${Object.keys(result).length} Slack channels for project ${projectName}`);
    return result;
  }

  async scanExistingChannels(): Promise<void> {
    try {
      const auth = await this.app.client.auth.test({ token: this.botToken });
      if (auth.team_id && auth.team) {
        this.workspaces = [{ id: auth.team_id, name: auth.team as string }];
      }

      const result = await this.app.client.conversations.list({
        token: this.botToken,
        types: 'public_channel,private_channel',
        limit: 1000,
      });

      for (const ch of result.channels || []) {
        if (ch.name && ch.id && ch.is_member) {
          console.log(`Slack channel found: #${ch.name} (${ch.id})`);
        }
      }
    } catch (error) {
      console.warn('Failed to scan existing Slack channels:', error);
    }
  }

  private async findChannelByName(channelName: string): Promise<string | undefined> {
    try {
      let cur: string | undefined;
      do {
        const page = await this.app.client.conversations.list({
          token: this.botToken,
          types: 'public_channel,private_channel',
          exclude_archived: false,
          limit: 200,
          ...(cur ? { cursor: cur } : {}),
        });
        for (const ch of page.channels || []) {
          if (ch.name === channelName && ch.id) {
            return ch.id;
          }
        }
        cur = page.response_metadata?.next_cursor || undefined;
      } while (cur);
    } catch {
      // Ignore search errors
    }
    return undefined;
  }
}
