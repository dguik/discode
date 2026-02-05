#!/usr/bin/env bash
# Claude Code PostToolUse hook
# Sends progress updates for important tools (Bash, Write, Edit) to Discord
# Other tools are silently approved

set -euo pipefail

BRIDGE_PORT="${AGENT_DISCORD_PORT:-18470}"
PROJECT_NAME="${AGENT_DISCORD_PROJECT:-}"

# Read hook input
HOOK_INPUT=$(cat)

# Always approve
trap 'echo "{\"decision\": \"approve\", \"reason\": \"OK\"}"' EXIT

# Skip if no project configured
[[ -z "$PROJECT_NAME" ]] && exit 0

# Extract tool info
TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // .toolName // ""' 2>/dev/null || echo "")
TOOL_INPUT=$(echo "$HOOK_INPUT" | jq -r '.tool_input // .input // {}' 2>/dev/null || echo "{}")

# Only notify for important tools
case "$TOOL_NAME" in
  Bash)
    CMD=$(echo "$TOOL_INPUT" | jq -r '.command // ""' 2>/dev/null | head -c 100)
    MSG="💻 \`${CMD}\`"
    ;;
  Write)
    FILE=$(echo "$TOOL_INPUT" | jq -r '.file_path // ""' 2>/dev/null)
    MSG="✏️ Wrote \`${FILE##*/}\`"
    ;;
  Edit)
    FILE=$(echo "$TOOL_INPUT" | jq -r '.file_path // ""' 2>/dev/null)
    MSG="✏️ Edited \`${FILE##*/}\`"
    ;;
  Task)
    DESC=$(echo "$TOOL_INPUT" | jq -r '.description // .prompt // ""' 2>/dev/null | head -c 80)
    MSG="🤖 Task: ${DESC}"
    ;;
  *)
    exit 0
    ;;
esac

# Send notification (fire and forget)
PAYLOAD=$(jq -n --arg msg "**Claude** - $MSG" '{message: $msg}')
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "http://127.0.0.1:${BRIDGE_PORT}/notify/${PROJECT_NAME}/claude" \
  --max-time 2 >/dev/null 2>&1 || true
