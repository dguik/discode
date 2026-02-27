import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import { agentRegistry } from '../../agents/index.js';
import { getConfigValue } from '../../config/index.js';
import { normalizeDiscordToken } from '../../config/token.js';
import type { OnboardWizardInitialState, OnboardWizardResult } from '../../../bin/onboard-tui.js';
import { parseRuntimeModeInput } from '../../runtime/mode.js';

type OnboardWizardCliOptions = {
  platform?: string;
  runtimeMode?: string;
  token?: string;
  slackBotToken?: string;
  slackAppToken?: string;
};

type OnboardWizardModule = {
  runOnboardTui?: (initial: OnboardWizardInitialState) => Promise<OnboardWizardResult | undefined>;
};

function handoffToBunRuntime(): never {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error('Onboarding TUI requires Bun runtime. Run with: bun dist/bin/discode.js onboard');
  }

  const result = spawnSync('bun', [scriptPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DISCODE_ONBOARD_BUN_HANDOFF: '1',
    },
  });

  if (result.error) {
    throw new Error('Onboarding TUI requires Bun runtime and could not auto-run Bun. Ensure `bun` is on PATH.');
  }

  process.exit(typeof result.status === 'number' ? result.status : 1);
}

async function loadOnboardTuiModule(): Promise<OnboardWizardModule> {
  const sourceCandidates = [
    new URL('./onboard-tui.js', import.meta.url),
    new URL('./onboard-tui.tsx', import.meta.url),
    new URL('../../bin/onboard-tui.tsx', import.meta.url),
    new URL('../../../dist/bin/onboard-tui.js', import.meta.url),
    new URL('../../../bin/onboard-tui.tsx', import.meta.url),
  ];

  let lastImportError: unknown;
  for (const candidate of sourceCandidates) {
    const candidatePath = fileURLToPath(candidate);
    if (!existsSync(candidatePath)) continue;
    try {
      const loaded = await import(candidate.href);
      if (loaded && typeof loaded.runOnboardTui === 'function') {
        return loaded as OnboardWizardModule;
      }
    } catch (error) {
      lastImportError = error;
    }
  }

  const suffix = lastImportError instanceof Error ? ` (last import error: ${lastImportError.message})` : '';
  throw new Error(`OpenTUI onboarding entry not found: bin/onboard-tui.tsx or dist/bin/onboard-tui.js${suffix}`);
}

export async function onboardWizardCommand(options: OnboardWizardCliOptions): Promise<OnboardWizardResult | undefined> {
  const isBunRuntime = Boolean((process as { versions?: { bun?: string } }).versions?.bun);
  if (!isBunRuntime) {
    if (process.env.DISCODE_ONBOARD_BUN_HANDOFF === '1') {
      // Bun handoff attempted but still not in Bun — fall back to CLI onboarding
      console.log(chalk.yellow('⚠️ TUI wizard requires Bun. Falling back to CLI onboarding...'));
      const { onboardCommand } = await import('./onboard.js');
      await onboardCommand({
        platform: options.platform,
        runtimeMode: options.runtimeMode,
        token: options.token,
        slackBotToken: options.slackBotToken,
        slackAppToken: options.slackAppToken,
        exitOnError: false,
      });
      return undefined;
    }
    try {
      handoffToBunRuntime();
    } catch {
      // Bun not available — fall back to CLI onboarding
      console.log(chalk.yellow('⚠️ TUI wizard requires Bun. Falling back to CLI onboarding...'));
      const { onboardCommand } = await import('./onboard.js');
      await onboardCommand({
        platform: options.platform,
        runtimeMode: options.runtimeMode,
        token: options.token,
        slackBotToken: options.slackBotToken,
        slackAppToken: options.slackAppToken,
        exitOnError: false,
      });
      return undefined;
    }
  }

  await import('@opentui/solid/preload');

  const mod = await loadOnboardTuiModule();
  if (!mod.runOnboardTui) {
    throw new Error('runOnboardTui entry is missing.');
  }

  const configuredPlatform = getConfigValue('messagingPlatform');
  const initialPlatform = options.platform === 'discord' || options.platform === 'slack'
    ? options.platform
    : configuredPlatform === 'slack' ? 'slack' : 'discord';

  const storedRuntimeMode = getConfigValue('runtimeMode');
  const initialRuntimeMode =
    parseRuntimeModeInput(options.runtimeMode)
    || parseRuntimeModeInput(storedRuntimeMode)
    || 'pty-ts';

  const installedAgents = agentRegistry
    .getAll()
    .filter((agent) => agent.isInstalled())
    .map((agent) => ({
      name: agent.config.name,
      displayName: agent.config.displayName,
    }));

  const initialState: OnboardWizardInitialState = {
    platform: initialPlatform,
    runtimeMode: initialRuntimeMode,
    discordToken: options.token,
    slackBotToken: options.slackBotToken,
    slackAppToken: options.slackAppToken,
    hasSavedDiscordToken: Boolean(normalizeDiscordToken(getConfigValue('token'))),
    hasSavedSlackBotToken: Boolean(getConfigValue('slackBotToken')?.trim()),
    hasSavedSlackAppToken: Boolean(getConfigValue('slackAppToken')?.trim()),
    defaultAgentCli: getConfigValue('defaultAgentCli'),
    telemetryEnabled: getConfigValue('telemetryEnabled') === true,
    opencodePermissionMode: getConfigValue('opencodePermissionMode') === 'allow' ? 'allow' : 'default',
    installedAgents,
  };

  const result = await mod.runOnboardTui(initialState);
  if (!result) {
    console.log(chalk.yellow('Onboarding canceled.'));
    return undefined;
  }
  return result;
}
