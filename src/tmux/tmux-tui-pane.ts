/**
 * TUI pane lifecycle operations for tmux windows.
 *
 * Manages creation, detection, sizing, and cleanup of the discode-tui
 * side pane within tmux windows.
 */

import type { ICommandExecutor } from '../types/interfaces.js';
import { escapeShellArg } from '../infra/shell-escape.js';
import {
  TUI_PANE_TITLE,
  listPaneMetadata,
  resolveWindowTarget,
} from './tmux-pane-resolver.js';

const TUI_PANE_COMMAND_MARKERS = ['discode.js tui', 'discode tui'];
const TUI_PANE_MAX_WIDTH = 80;
const TUI_PANE_DELAY_SECONDS = 0.35;

export function findTuiPaneTargets(executor: ICommandExecutor, sessionName: string, windowName: string): string[] {
  const baseTarget = `${sessionName}:${windowName}`;
  try {
    const matches = listPaneMetadata(executor, sessionName, windowName)
      .map((pane) => {
        const byTitle = pane.title === TUI_PANE_TITLE;
        const byCommand = TUI_PANE_COMMAND_MARKERS.some((marker) => pane.startCommand.includes(marker));
        if (!byTitle && !byCommand) return null;

        return {
          target: `${baseTarget}.${pane.index}`,
          byTitle,
          index: pane.index,
        };
      })
      .filter((pane): pane is { target: string; byTitle: boolean; index: number } => pane !== null)
      .sort((a, b) => {
        if (a.byTitle !== b.byTitle) return a.byTitle ? -1 : 1;
        return a.index - b.index;
      });

    const uniqueTargets = new Set<string>();
    for (const match of matches) {
      uniqueTargets.add(match.target);
    }
    return [...uniqueTargets];
  } catch {
    return [];
  }
}

export function getWindowWidth(executor: ICommandExecutor, target: string): number | undefined {
  try {
    const output = executor.exec(`tmux display-message -p -t ${escapeShellArg(target)} "#{window_width}"`);
    const width = parseInt(output.trim(), 10);
    return Number.isFinite(width) ? width : undefined;
  } catch {
    return undefined;
  }
}

export function getTuiPaneWidth(executor: ICommandExecutor, windowTarget: string): number {
  const windowWidth = getWindowWidth(executor, windowTarget);
  if (windowWidth === undefined) {
    return TUI_PANE_MAX_WIDTH;
  }

  // Keep the TUI pane narrower than the AI pane.
  const maxByBalance = Math.floor((windowWidth - 1) / 2);
  return Math.max(1, Math.min(TUI_PANE_MAX_WIDTH, maxByBalance));
}

export function resizePaneWidth(executor: ICommandExecutor, target: string, width: number): void {
  try {
    executor.exec(`tmux resize-pane -t ${escapeShellArg(target)} -x ${width}`);
  } catch {
    // Best effort.
  }
}

export function forceTuiPaneWidth(
  executor: ICommandExecutor,
  sessionName: string,
  windowName: string,
  tuiTarget: string,
  width: number,
): void {
  const windowTarget = `${sessionName}:${windowName}`;
  const windowWidth = getWindowWidth(executor, windowTarget);
  const paneCount = listPaneMetadata(executor, sessionName, windowName).length;

  try {
    executor.exec(`tmux set-window-option -t ${escapeShellArg(windowTarget)} window-size latest`);
  } catch {
    // Best effort.
  }

  if (windowWidth !== undefined && paneCount === 2) {
    const mainPaneWidth = Math.max(1, windowWidth - width - 1);
    try {
      executor.exec(`tmux select-layout -t ${escapeShellArg(windowTarget)} main-vertical`);
    } catch {
      // Best effort.
    }
    try {
      executor.exec(`tmux set-window-option -t ${escapeShellArg(windowTarget)} main-pane-width ${mainPaneWidth}`);
    } catch {
      // Best effort.
    }
  }

  resizePaneWidth(executor, tuiTarget, width);

  const delayedScript =
    `sleep ${TUI_PANE_DELAY_SECONDS}; ` +
    `tmux set-window-option -t ${escapeShellArg(windowTarget)} window-size latest >/dev/null 2>&1; ` +
    `tmux display-message -p -t ${escapeShellArg(tuiTarget)} "#{pane_id}" >/dev/null 2>&1 && ` +
    `tmux resize-pane -t ${escapeShellArg(tuiTarget)} -x ${width} >/dev/null 2>&1; ` +
    `true`;
  try {
    executor.exec(`tmux run-shell -b ${escapeShellArg(delayedScript)}`);
  } catch {
    // Best effort.
  }
}

export function ensureTuiPane(
  executor: ICommandExecutor,
  sessionName: string,
  windowName: string,
  tuiCommand: string[] | string,
): void {
  const baseTarget = `${sessionName}:${windowName}`;
  const splitWidth = getTuiPaneWidth(executor, baseTarget);
  const escapedTuiCommand = Array.isArray(tuiCommand)
    ? tuiCommand.map((part) => escapeShellArg(part)).join(' ')
    : tuiCommand;

  const existingTuiTargets = findTuiPaneTargets(executor, sessionName, windowName);
  if (existingTuiTargets.length > 0) {
    const [primaryTarget, ...duplicateTargets] = existingTuiTargets;
    for (const duplicateTarget of duplicateTargets) {
      try {
        executor.exec(`tmux kill-pane -t ${escapeShellArg(duplicateTarget)}`);
      } catch {
        // Keep going if cleanup fails for a stale pane target.
      }
    }
    forceTuiPaneWidth(executor, sessionName, windowName, primaryTarget, splitWidth);
    return;
  }

  const activeTarget = resolveWindowTarget(executor, sessionName, windowName);
  const paneIndexOutput = executor.exec(
    `tmux split-window -P -F "#{pane_index}" -t ${escapeShellArg(activeTarget)} -h -l ${splitWidth} ${escapedTuiCommand}`,
  );
  const paneIndex = paneIndexOutput.trim();
  if (/^\d+$/.test(paneIndex)) {
    const tuiTarget = `${baseTarget}.${paneIndex}`;
    executor.exec(`tmux select-pane -t ${escapeShellArg(tuiTarget)} -T ${escapeShellArg(TUI_PANE_TITLE)}`);
    forceTuiPaneWidth(executor, sessionName, windowName, tuiTarget, splitWidth);
  }

  executor.exec(`tmux select-pane -t ${escapeShellArg(activeTarget)}`);
}
