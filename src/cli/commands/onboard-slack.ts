/**
 * Slack-specific onboarding flow — bot/app token prompts, workspace detection.
 *
 * Extracted from onboard.ts so Slack changes don't affect Discord onboarding.
 */

import chalk from 'chalk';
import { stateManager } from '../../state/index.js';
import { SlackClient } from '../../slack/client.js';
import { getConfigValue, saveConfig } from '../../config/index.js';
import { confirmYesNo, prompt } from '../common/interactive.js';

export async function onboardSlack(
  options?: { botToken?: string; appToken?: string },
  interactive: boolean = true
): Promise<void> {
  const existingBotToken = getConfigValue('slackBotToken')?.trim();
  const existingAppToken = getConfigValue('slackAppToken')?.trim();

  let botToken: string | undefined = options?.botToken;
  let appToken: string | undefined = options?.appToken;

  if (botToken && appToken) {
    // Tokens provided via CLI flags — skip interactive prompts.
  } else if (existingBotToken && existingAppToken && interactive) {
    const maskedBot = `****${existingBotToken.slice(-4)}`;
    const reuse = await confirmYesNo(
      chalk.white(`Previously saved Slack tokens found (Bot: ${maskedBot}). Use them? [Y/n]: `),
      true
    );
    if (reuse) {
      botToken = existingBotToken;
      appToken = existingAppToken;
      console.log(chalk.green(`✅ Reusing saved Slack tokens`));
    }
  } else if (existingBotToken && existingAppToken && !interactive) {
    botToken = existingBotToken;
    appToken = existingAppToken;
    console.log(chalk.yellow(`⚠️ Non-interactive shell: using previously saved Slack tokens.`));
  }

  if (!botToken) {
    if (!interactive) {
      console.error(chalk.red('Slack tokens are required in non-interactive mode.'));
      console.log(chalk.gray('Run: discode config --slack-bot-token TOKEN --slack-app-token TOKEN --platform slack'));
      throw new Error('Slack bot token is required in non-interactive mode.');
    }
    botToken = await prompt(chalk.white('Slack Bot Token (xoxb-...): '));
    if (!botToken) {
      throw new Error('Slack bot token is required.');
    }
  }

  if (!appToken) {
    if (!interactive) {
      throw new Error('Slack app-level token is required in non-interactive mode.');
    }
    appToken = await prompt(chalk.white('Slack App-Level Token (xapp-...): '));
    if (!appToken) {
      throw new Error('Slack app-level token is required.');
    }
  }

  saveConfig({ slackBotToken: botToken, slackAppToken: appToken });
  console.log(chalk.green('✅ Slack tokens saved'));

  console.log(chalk.gray('   Connecting to Slack...'));
  const client = new SlackClient(botToken, appToken);
  await client.connect();

  const workspaces = client.getGuilds();
  if (workspaces.length > 0) {
    const ws = workspaces[0];
    console.log(chalk.green(`✅ Workspace detected: ${ws.name} (${ws.id})`));
    stateManager.setWorkspaceId(ws.id);
  } else {
    console.log(chalk.yellow('⚠️ Could not detect workspace. You may need to set server ID manually.'));
  }

  await client.disconnect();
}
