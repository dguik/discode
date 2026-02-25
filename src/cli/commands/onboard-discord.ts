/**
 * Discord-specific onboarding flow — token prompt, server selection.
 *
 * Extracted from onboard.ts so Discord changes don't affect Slack onboarding.
 */

import chalk from 'chalk';
import { stateManager } from '../../state/index.js';
import { DiscordClient } from '../../discord/client.js';
import { getConfigValue, saveConfig } from '../../config/index.js';
import { normalizeDiscordToken } from '../../config/token.js';
import { confirmYesNo, prompt } from '../common/interactive.js';

export async function onboardDiscord(token?: string, interactive: boolean = true): Promise<void> {
  const existingToken = normalizeDiscordToken(getConfigValue('token'));
  token = normalizeDiscordToken(token);
  if (!token) {
    if (existingToken) {
      if (interactive) {
        const maskedToken = `****${existingToken.slice(-4)}`;
        const reuseToken = await confirmYesNo(
          chalk.white(`Previously saved Discord bot token found (${maskedToken}). Use it? [Y/n]: `),
          true
        );
        if (reuseToken) {
          token = existingToken;
          console.log(chalk.green(`✅ Reusing saved bot token (${maskedToken})`));
        }
      } else {
        token = existingToken;
        console.log(chalk.yellow(`⚠️ Non-interactive shell: using previously saved bot token (****${existingToken.slice(-4)}).`));
      }
    }

    if (!token && !interactive) {
      console.error(chalk.red('Token is required in non-interactive mode.'));
      console.log(chalk.gray('Run: discode onboard --token YOUR_DISCORD_BOT_TOKEN'));
      console.log(chalk.gray('How to create a Discord bot token: https://discode.chat/docs/discord-bot'));
      throw new Error('Discord bot token is required in non-interactive mode.');
    }

    if (!token) {
      console.log(chalk.gray('Need a bot token? See: https://discode.chat/docs/discord-bot'));
      token = normalizeDiscordToken(await prompt(chalk.white('Discord bot token: ')));
    }
    if (!token) {
      console.log(chalk.gray('How to create a Discord bot token: https://discode.chat/docs/discord-bot'));
      throw new Error('Discord bot token is required.');
    }
  }

  saveConfig({ token });
  console.log(chalk.green('✅ Bot token saved'));

  console.log(chalk.gray('   Connecting to Discord...'));
  const client = new DiscordClient(token);
  await client.connect();

  const guilds = client.getGuilds();
  let selectedGuild: { id: string; name: string };

  if (guilds.length === 0) {
    console.error(chalk.red('\n❌ Bot is not in any server.'));
    console.log(chalk.gray('   Invite your bot to a server first:'));
    console.log(chalk.gray('   https://discord.com/developers/applications → OAuth2 → URL Generator'));
    await client.disconnect();
    throw new Error('Bot is not in any Discord server.');
  }

  if (guilds.length === 1) {
    selectedGuild = guilds[0];
    console.log(chalk.green(`✅ Server detected: ${selectedGuild.name} (${selectedGuild.id})`));
  } else {
    console.log(chalk.white('\n   Bot is in multiple servers:\n'));
    guilds.forEach((g, i) => {
      console.log(chalk.gray(`   ${i + 1}. ${g.name} (${g.id})`));
    });

    if (!interactive) {
      selectedGuild = guilds[0];
      console.log(chalk.yellow(`⚠️ Non-interactive shell: selecting first server ${selectedGuild.name} (${selectedGuild.id}).`));
    } else {
      const answer = await prompt(chalk.white(`\n   Select server [1-${guilds.length}]: `));
      const idx = parseInt(answer, 10) - 1;
      if (idx < 0 || idx >= guilds.length) {
        await client.disconnect();
        throw new Error('Invalid server selection.');
      }
      selectedGuild = guilds[idx];
      console.log(chalk.green(`✅ Server selected: ${selectedGuild.name}`));
    }
  }

  stateManager.setGuildId(selectedGuild.id);
  saveConfig({ serverId: selectedGuild.id });
  await client.disconnect();
}
