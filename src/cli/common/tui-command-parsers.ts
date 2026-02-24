export type ParsedNewCommand = {
  projectName?: string;
  agentName?: string;
  attach: boolean;
  instanceId?: string;
};

export function parseNewCommand(raw: string): ParsedNewCommand {
  const parts = raw.split(/\s+/).filter(Boolean);
  let attach = false;
  let instanceId: string | undefined;
  const values: string[] = [];

  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === '--attach') {
      attach = true;
      continue;
    }
    if (part === '--instance' && parts[i + 1]) {
      instanceId = parts[i + 1];
      i += 1;
      continue;
    }
    if (part.startsWith('--instance=')) {
      const value = part.slice('--instance='.length).trim();
      if (value) instanceId = value;
      continue;
    }
    if (part.startsWith('--')) continue;
    values.push(part);
  }

  const projectName = values[0];
  const agentName = values[1];
  return { projectName, agentName, attach, instanceId };
}

export type ParsedOnboardCommand = {
  options: {
    platform?: 'discord' | 'slack';
    runtimeMode?: 'tmux' | 'pty';
    token?: string;
    slackBotToken?: string;
    slackAppToken?: string;
    defaultAgentCli?: string;
    telemetryEnabled?: boolean;
    opencodePermissionMode?: 'allow' | 'default';
  };
  showUsage?: boolean;
  error?: string;
};

export function parseOnboardCommand(raw: string): ParsedOnboardCommand {
  const parts = raw.split(/\s+/).filter(Boolean);
  const options: ParsedOnboardCommand['options'] = {};
  const toBoolean = (value: string): boolean | undefined => {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'on' || lowered === 'true' || lowered === '1' || lowered === 'yes' || lowered === 'y') return true;
    if (lowered === 'off' || lowered === 'false' || lowered === '0' || lowered === 'no' || lowered === 'n') return false;
    return undefined;
  };

  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === '--help' || part === '-h') {
      return { options, showUsage: true };
    }

    const eqIndex = part.indexOf('=');
    const flag = eqIndex >= 0 ? part.slice(0, eqIndex) : part;
    const inlineValue = eqIndex >= 0 ? part.slice(eqIndex + 1) : undefined;
    const readValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      const next = parts[i + 1];
      if (!next || next.startsWith('--')) return undefined;
      i += 1;
      return next;
    };

    if (!part.startsWith('--')) {
      if (!options.platform && (part === 'discord' || part === 'slack')) {
        options.platform = part;
        continue;
      }
      return { options, error: `Unknown option: ${part}` };
    }

    if (flag === '--platform') {
      const value = (readValue() || '').toLowerCase();
      if (value !== 'discord' && value !== 'slack') {
        return { options, error: 'platform must be discord or slack.' };
      }
      options.platform = value;
      continue;
    }

    if (flag === '--runtime-mode') {
      const value = (readValue() || '').toLowerCase();
      if (value !== 'tmux' && value !== 'pty') {
        return { options, error: 'runtime mode must be tmux or pty.' };
      }
      options.runtimeMode = value;
      continue;
    }

    if (flag === '--token') {
      const value = readValue();
      if (!value) return { options, error: 'token requires a value.' };
      options.token = value;
      continue;
    }

    if (flag === '--slack-bot-token') {
      const value = readValue();
      if (!value) return { options, error: 'slack-bot-token requires a value.' };
      options.slackBotToken = value;
      continue;
    }

    if (flag === '--slack-app-token') {
      const value = readValue();
      if (!value) return { options, error: 'slack-app-token requires a value.' };
      options.slackAppToken = value;
      continue;
    }

    if (flag === '--default-agent') {
      const value = readValue();
      if (!value) return { options, error: 'default-agent requires a value.' };
      options.defaultAgentCli = value;
      continue;
    }

    if (flag === '--telemetry') {
      const value = readValue();
      if (!value) return { options, error: 'telemetry requires a value (on/off).' };
      const telemetryEnabled = toBoolean(value);
      if (telemetryEnabled === undefined) {
        return { options, error: 'telemetry must be on/off/true/false.' };
      }
      options.telemetryEnabled = telemetryEnabled;
      continue;
    }

    if (flag === '--opencode-permission') {
      const value = (readValue() || '').toLowerCase();
      if (value !== 'allow' && value !== 'default') {
        return { options, error: 'opencode-permission must be allow or default.' };
      }
      options.opencodePermissionMode = value;
      continue;
    }

    return { options, error: `Unknown option: ${flag}` };
  }

  return { options };
}
