/**
 * Pane resolution logic for tmux window targeting.
 *
 * Resolves the correct pane within a tmux window based on agent type
 * hints, avoiding TUI panes and handling pane-base-index differences.
 */

import type { ICommandExecutor } from '../types/interfaces.js';
import { escapeShellArg } from '../infra/shell-escape.js';

export const TUI_PANE_TITLE = 'discode-tui';

export type AgentPaneHint = 'opencode' | 'claude' | 'gemini';

export const AGENT_PANE_MARKERS: Record<AgentPaneHint, string[]> = {
  opencode: ['opencode'],
  claude: ['claude'],
  gemini: ['gemini'],
};

export type PaneMetadata = {
  index: number;
  title: string;
  startCommand: string;
};

export function listPaneMetadata(executor: ICommandExecutor, sessionName: string, windowName: string): PaneMetadata[] {
  const baseTarget = `${sessionName}:${windowName}`;
  const escapedBaseTarget = escapeShellArg(baseTarget);
  const output = executor.exec(
    `tmux list-panes -t ${escapedBaseTarget} -F "#{pane_index}\t#{pane_title}\t#{pane_start_command}"`,
  );

  return output
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [indexRaw, titleRaw = '', ...startCommandRest] = line.split('\t');
      const index = /^\d+$/.test(indexRaw) ? parseInt(indexRaw, 10) : NaN;
      return {
        index,
        title: titleRaw,
        startCommand: startCommandRest.join('\t'),
      };
    })
    .filter((pane) => Number.isFinite(pane.index));
}

export function resolveAgentPaneHint(targetHint: string): AgentPaneHint | null {
  const normalized = targetHint.trim().toLowerCase();
  if (normalized.length === 0) return null;
  if (/\bopencode\b/.test(normalized)) return 'opencode';
  if (/\bclaude\b/.test(normalized)) return 'claude';
  if (/\bgemini\b/.test(normalized)) return 'gemini';
  return null;
}

export function matchesAgentPane(pane: PaneMetadata, hint: AgentPaneHint): boolean {
  if (pane.title === TUI_PANE_TITLE) return false;
  const haystack = `${pane.title}\n${pane.startCommand}`.toLowerCase();
  return AGENT_PANE_MARKERS[hint].some((marker) => haystack.includes(marker));
}

/**
 * Resolve a tmux target for a window.
 *
 * If caller already provides an explicit pane target (e.g. `gemini.1`), keep it.
 * Otherwise, resolve the lowest existing pane index for the target window.
 * This avoids active-pane drift while also working when tmux pane-base-index is 1.
 */
export function resolveWindowTarget(executor: ICommandExecutor, sessionName: string, windowName: string, paneHint?: string): string {
  const hasExplicitPane = /\.\d+$/.test(windowName);
  if (hasExplicitPane) {
    return `${sessionName}:${windowName}`;
  }

  const baseTarget = `${sessionName}:${windowName}`;

  try {
    const panes = listPaneMetadata(executor, sessionName, windowName);

    const hintedAgent = resolveAgentPaneHint(paneHint || windowName);
    if (hintedAgent) {
      const hintedPaneIndexes = panes
        .filter((pane) => matchesAgentPane(pane, hintedAgent))
        .map((pane) => pane.index);
      if (hintedPaneIndexes.length > 0) {
        const firstHintedPane = Math.min(...hintedPaneIndexes);
        return `${baseTarget}.${firstHintedPane}`;
      }
    }

    const nonTuiPaneIndexes = panes
      .filter((pane) => pane.title !== TUI_PANE_TITLE)
      .map((pane) => pane.index);

    if (nonTuiPaneIndexes.length > 0) {
      const firstNonTuiPane = Math.min(...nonTuiPaneIndexes);
      return `${baseTarget}.${firstNonTuiPane}`;
    }

    const paneIndexes = panes.map((pane) => pane.index);

    if (paneIndexes.length > 0) {
      const firstPane = Math.min(...paneIndexes);
      return `${baseTarget}.${firstPane}`;
    }
  } catch {
    // Fall back to plain window target.
  }

  return baseTarget;
}
