/**
 * Tmux pane process management — PID listing, signaling, cleanup.
 *
 * Extracted from tmux.ts so process lifecycle changes
 * don't affect TUI pane setup or config overrides.
 */

import { execSync } from 'child_process';
import { escapeShellArg } from '../../infra/shell-escape.js';

const TUI_PROCESS_COMMAND_MARKERS = ['/dist/bin/discode.js tui', '/bin/discode.js tui', 'discode.js tui', '/bin/discode tui', 'discode tui'];

function isDiscodeTuiProcess(command: string): boolean {
  return TUI_PROCESS_COMMAND_MARKERS.some((marker) => command.includes(marker));
}

export function listPanePids(target: string): number[] {
  try {
    const output = execSync(`tmux list-panes -t ${escapeShellArg(target)} -F "#{pane_pid}"`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    });
    const pids = output
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .map((line) => parseInt(line, 10))
      .filter((pid) => Number.isFinite(pid) && pid > 1);
    return [...new Set(pids)];
  } catch {
    return [];
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function signalProcessTree(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // Fall through to direct PID signal.
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export async function terminateTmuxPaneProcesses(target: string): Promise<number> {
  const panePids = listPanePids(target);
  if (panePids.length === 0) return 0;

  for (const pid of panePids) {
    signalProcessTree(pid, 'SIGTERM');
  }

  await new Promise((resolve) => setTimeout(resolve, 250));

  let forcedKillCount = 0;
  for (const pid of panePids) {
    if (!isProcessRunning(pid)) continue;
    if (signalProcessTree(pid, 'SIGKILL')) {
      forcedKillCount += 1;
    }
  }
  return forcedKillCount;
}

export function listActiveTmuxPaneTtys(): Set<string> {
  try {
    const output = execSync('tmux list-panes -a -F "#{pane_tty}"', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    });
    return new Set(
      output
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('/dev/'))
    );
  } catch {
    return new Set();
  }
}

export function cleanupStaleDiscodeTuiProcesses(): number {
  const activePaneTtys = listActiveTmuxPaneTtys();
  if (activePaneTtys.size === 0) return 0;

  let processTable = '';
  try {
    processTable = execSync('ps -axo pid=,ppid=,tty=,command=', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    });
  } catch {
    return 0;
  }

  type PsRow = {
    pid: number;
    ppid: number;
    tty: string | undefined;
    command: string;
  };

  const rows: PsRow[] = processTable
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) return [];
      const pid = parseInt(match[1], 10);
      const ppid = parseInt(match[2], 10);
      const ttyRaw = match[3];
      const tty = ttyRaw === '?' ? undefined : ttyRaw.startsWith('/dev/') ? ttyRaw : `/dev/${ttyRaw}`;
      const command = match[4];
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return [];
      return [{ pid, ppid, tty, command }];
    });

  const tmuxPids = new Set(
    rows
      .filter((row) => row.command === 'tmux')
      .map((row) => row.pid)
  );
  if (tmuxPids.size === 0) return 0;

  let cleaned = 0;
  for (const row of rows) {
    if (!tmuxPids.has(row.ppid)) continue;
    if (!isDiscodeTuiProcess(row.command)) continue;
    if (row.tty && activePaneTtys.has(row.tty)) continue;

    if (signalProcessTree(row.pid, 'SIGTERM')) {
      cleaned += 1;
    }
  }
  return cleaned;
}
