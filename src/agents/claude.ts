/**
 * Claude Code agent adapter
 */

import { BaseAgentAdapter, HookData, AgentConfig } from './base.js';

const claudeConfig: AgentConfig = {
  name: 'claude',
  displayName: 'Claude Code',
  command: 'claude',
  hookEndpoint: 'claude',
  channelSuffix: 'claude',
};

export class ClaudeAdapter extends BaseAgentAdapter {
  constructor() {
    super(claudeConfig);
  }

  getStartCommand(projectPath: string, yolo = false): string {
    const flags = yolo ? ' --dangerously-skip-permissions' : '';
    return `cd "${projectPath}" && ${this.config.command}${flags}`;
  }

  formatHookOutput(hookData: HookData): string {
    const toolName = hookData.tool_name || hookData.toolName || 'unknown';
    const toolInput = hookData.tool_input || hookData.input || {};
    let output = hookData.tool_response || hookData.output || '';

    // Convert object output to string if needed
    if (typeof output === 'object') {
      output = JSON.stringify(output, null, 2);
    }

    // Helper to extract basename from path
    const basename = (path: string): string => {
      return path.split('/').pop() || path;
    };

    // Helper to count lines in text
    const countLines = (text: string): number => {
      return text.split('\n').length;
    };

    // Helper to truncate text
    const truncate = (text: string, maxLen: number): string => {
      return text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
    };

    let summary: string;

    switch (toolName.toLowerCase()) {
      case 'read': {
        const filePath = toolInput.file_path || 'unknown file';
        const lineCount = countLines(output);
        summary = `📄 \`${basename(filePath)}\` (${lineCount} lines)`;
        break;
      }

      case 'write': {
        const filePath = toolInput.file_path || 'unknown file';
        summary = `✏️ Wrote \`${basename(filePath)}\``;
        break;
      }

      case 'edit': {
        const filePath = toolInput.file_path || 'unknown file';
        summary = `✏️ Edited \`${basename(filePath)}\``;
        break;
      }

      case 'glob': {
        const lines = output.trim().split('\n').filter((l: string) => l.trim());
        const fileCount = lines.length;
        const firstFew = lines.slice(0, 3).map(basename).join(', ');
        summary = `🔍 Found ${fileCount} file${fileCount !== 1 ? 's' : ''}${firstFew ? `: ${firstFew}${fileCount > 3 ? ', ...' : ''}` : ''}`;
        break;
      }

      case 'grep': {
        const lines = output.trim().split('\n').filter((l: string) => l.trim());
        const files = new Set(lines.map((l: string) => l.split(':')[0]).filter(Boolean));
        summary = `🔍 Found matches in ${files.size} file${files.size !== 1 ? 's' : ''}`;
        break;
      }

      case 'bash': {
        const command = toolInput.command || 'unknown command';
        const cmdDisplay = truncate(command, 60);
        const outputBrief = truncate(output.trim(), 200);
        summary = `💻 \`${cmdDisplay}\`${outputBrief ? `\n${outputBrief}` : ''}`;
        break;
      }

      case 'task': {
        const description = toolInput.prompt || toolInput.description || 'task';
        const descBrief = truncate(description, 100);
        summary = `🤖 Delegated: ${descBrief}`;
        break;
      }

      case 'askuserquestion': {
        const question = toolInput.question || output;
        const questionBrief = truncate(question, 150);
        summary = `❓ ${questionBrief}`;
        break;
      }

      default: {
        const outputBrief = truncate(output.trim(), 200);
        summary = `🔧 ${toolName}${outputBrief ? `\n${outputBrief}` : ''}`;
        break;
      }
    }

    return `**Claude** - ${summary}`;
  }

  getHookScript(bridgePort: number): string {
    return `#!/usr/bin/env bash
# Claude Code PostToolUse hook for discord-agent-bridge
# This script sends tool outputs to the bridge server

BRIDGE_PORT="\${AGENT_DISCORD_PORT:-${bridgePort}}"
PROJECT_NAME="\${AGENT_DISCORD_PROJECT:-}"

# Read hook input from stdin
HOOK_INPUT=$(cat)

# Send to bridge if project is configured
if [[ -n "$PROJECT_NAME" ]]; then
  curl -s -X POST \\
    -H "Content-Type: application/json" \\
    -d "$HOOK_INPUT" \\
    "http://127.0.0.1:\${BRIDGE_PORT}/hook/\${PROJECT_NAME}/claude" \\
    --max-time 2 >/dev/null 2>&1 || true
fi

# Return approval response
cat << 'EOF'
{"decision": "approve", "reason": "Hook processed"}
EOF
`;
  }

  getHookInstallPath(): string {
    return '~/.claude/settings.json';
  }

  /**
   * Get the settings.json hook configuration
   */
  getSettingsConfig(hookScriptPath: string): object {
    const hooksDir = hookScriptPath.replace(/\/[^/]+$/, '');
    return {
      hooks: {
        PreToolUse: [
          {
            matcher: '',
            hooks: [
              {
                type: 'command',
                command: `${hooksDir}/claude-pre-tool.sh`,
                timeout: 120,
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: '',
            hooks: [
              {
                type: 'command',
                command: hookScriptPath,
              },
            ],
          },
        ],
        Stop: [
          {
            matcher: '',
            hooks: [
              {
                type: 'command',
                command: `${hooksDir}/claude-stop.sh`,
                timeout: 10,
              },
            ],
          },
        ],
      },
    };
  }
}

export const claudeAdapter = new ClaudeAdapter();
