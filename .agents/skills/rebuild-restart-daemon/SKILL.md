---
name: rebuild-restart-daemon
description: Rebuild and restart the Discord Agent Bridge daemon for the agent-messenger-bridge project. Use when Codex must apply local code changes to the running daemon, recover from stale daemon state, or verify daemon health after config or environment updates.
---

# Rebuild Restart Daemon

## Overview

Rebuild the local project and restart its global daemon process with status verification. Prefer the bundled script for deterministic, repeatable execution.

## Workflow

1. Confirm the target directory is the `discord-agent-bridge` repository.
2. Run the bundled script to rebuild and restart daemon.
3. Verify daemon status and report log path when failures occur.

## Execute Script

Run:

```bash
bash "$(git rev-parse --show-toplevel)/.agents/skills/rebuild-restart-daemon/scripts/rebuild_restart_daemon.sh" --repo /path/to/discord-agent-bridge
```

If the skill bundle is mirrored under `~/.codex/skills`, this path also works:

```bash
bash /Users/dev/.codex/skills/rebuild-restart-daemon/scripts/rebuild_restart_daemon.sh --repo /path/to/discord-agent-bridge
```

Use options:

- `--repo <path>`: target repository path (default: current directory)
- `--skip-build`: skip `npm run build` and only restart daemon
- `--dry-run`: print commands without executing them

## Manual Fallback

Run:

```bash
cd /path/to/discord-agent-bridge
npm run build
node dist/bin/agent-bridge.js daemon stop
node dist/bin/agent-bridge.js daemon start
node dist/bin/agent-bridge.js daemon status
```

## Troubleshooting

- Inspect daemon log at `~/.agent-messenger-bridge/daemon.log`.
- Inspect daemon pid at `~/.agent-messenger-bridge/daemon.pid`.
- Re-run `node dist/bin/agent-bridge.js daemon status` after resolving errors.
