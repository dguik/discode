import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { config, getConfigValue } from '../../config/index.js';
import { stateManager } from '../../state/index.js';
import { agentRegistry } from '../../agents/index.js';
import { TmuxManager } from '../../tmux/manager.js';
import { listProjectInstances } from '../../state/instances.js';
import type { TmuxCliOptions } from '../common/types.js';
import {
  applyTmuxCliOverrides,
  getEnabledAgentNames,
  isTmuxPaneAlive,
  resolveProjectWindowName,
  waitForTmuxPaneAlive,
} from '../common/tmux.js';
import { RuntimeSessionManager } from '../common/runtime-session-manager.js';
import { handleTuiCommand } from './tui-command-handler.js';
import { attachCommand } from './attach.js';
import { stopCommand } from './stop.js';

function nextProjectName(baseName: string): string {
  if (!stateManager.getProject(baseName)) return baseName;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${baseName}-${i}`;
    if (!stateManager.getProject(candidate)) return candidate;
  }
  return `${baseName}-${Date.now()}`;
}

function reloadStateFromDisk(): void {
  stateManager.reload();
}

function handoffToBunRuntime(): never {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error('TUI requires Bun runtime. Run with: bun dist/bin/discode.js');
  }

  const result = spawnSync('bun', [scriptPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DISCODE_TUI_BUN_HANDOFF: '1',
    },
  });

  if (result.error) {
    throw new Error('TUI requires Bun runtime and could not auto-run Bun. Ensure `bun` is on PATH.');
  }

  process.exit(typeof result.status === 'number' ? result.status : 1);
}

function resolveRuntimeWindowForProject(
  projectName: string,
  tmuxConfig: typeof config.tmux,
): { windowId: string; sessionName: string; windowName: string } | null {
  const project = stateManager.getProject(projectName);
  if (!project) return null;
  const instances = listProjectInstances(project);
  const firstInstance = instances[0];
  if (!firstInstance) return null;
  const windowName = resolveProjectWindowName(project, firstInstance.agentType, tmuxConfig, firstInstance.instanceId);
  return {
    windowId: `${project.tmuxSession}:${windowName}`,
    sessionName: project.tmuxSession,
    windowName,
  };
}

export async function tuiCommand(options: TmuxCliOptions): Promise<void> {
  const effectiveConfig = applyTmuxCliOverrides(config, options);
  const runtimePort = effectiveConfig.hookServerPort || 18470;
  let keepChannelOnStop = getConfigValue('keepChannelOnStop') === true;

  const session = new RuntimeSessionManager(runtimePort);
  await session.connect();

  const isBunRuntime = Boolean((process as { versions?: { bun?: string } }).versions?.bun);
  if (!isBunRuntime) {
    if (process.env.DISCODE_TUI_BUN_HANDOFF === '1') {
      throw new Error('TUI requires Bun runtime. Run with: bun dist/bin/discode.js');
    }
    handoffToBunRuntime();
  }

  await import('@opentui/solid/preload');
  const tmuxPaneTarget = process.env.TMUX_PANE;
  const startedFromTmux = !!process.env.TMUX;
  if (startedFromTmux) {
    const paneReady = tmuxPaneTarget ? await waitForTmuxPaneAlive(tmuxPaneTarget) : false;
    if (!paneReady) {
      console.log(chalk.yellow('⚠️ Stale tmux environment detected; skipping TUI startup to avoid orphaned process.'));
      return;
    }
  }

  let tmuxHealthTimer: ReturnType<typeof setInterval> | undefined;
  if (startedFromTmux) {
    tmuxHealthTimer = setInterval(() => {
      if (isTmuxPaneAlive(tmuxPaneTarget)) return;
      console.log(chalk.yellow('\n⚠️ tmux session/pane ended; exiting TUI to prevent leaked process.'));
      process.exit(0);
    }, 5000);
    tmuxHealthTimer.unref();
  }

  const clearTmuxHealthTimer = () => {
    if (!tmuxHealthTimer) return;
    clearInterval(tmuxHealthTimer);
    tmuxHealthTimer = undefined;
  };
  process.once('exit', clearTmuxHealthTimer);

  const tmux = new TmuxManager(config.tmux.sessionPrefix);
  const runtimeAtStartup = await session.fetchWindows();
  const parseWindowId = (windowId: string | undefined): { sessionName: string; windowName: string } | null => {
    if (!windowId) return null;
    const idx = windowId.indexOf(':');
    if (idx <= 0 || idx >= windowId.length - 1) return null;
    return { sessionName: windowId.slice(0, idx), windowName: windowId.slice(idx + 1) };
  };
  const runtimeActiveAtStartup = parseWindowId(runtimeAtStartup?.activeWindowId);
  const currentSession = runtimeActiveAtStartup?.sessionName || tmux.getCurrentSession(process.env.TMUX_PANE);
  const currentWindow = runtimeActiveAtStartup?.windowName || tmux.getCurrentWindow(process.env.TMUX_PANE);
  const runtimeModeAtLaunch = effectiveConfig.runtimeMode || 'tmux';
  const daemonLogFile = defaultDaemonManager.getLogFile();
  let runtimeBackendCache: { mtimeMs: number; status: RuntimeBackendStatus | undefined } | undefined;

  const getRuntimeBackendStatus = async (): Promise<RuntimeBackendStatus | undefined> => {
    if (runtimeModeAtLaunch !== 'pty-rust') return undefined;
    if (!existsSync(daemonLogFile)) return undefined;

    const mtimeMs = statSync(daemonLogFile).mtimeMs;
    if (runtimeBackendCache && runtimeBackendCache.mtimeMs === mtimeMs) {
      return runtimeBackendCache.status;
    }

    const tail = readFileTailUtf8(daemonLogFile, 96 * 1024);
    const status = detectPtyRustBackendStatus(tail);
    runtimeBackendCache = { mtimeMs, status };
    return status;
  };

  const sourceCandidates = [
    new URL('./tui.js', import.meta.url),
    new URL('./tui.tsx', import.meta.url),
    new URL('../../bin/tui.tsx', import.meta.url),
    new URL('../../../dist/bin/tui.js', import.meta.url),
    new URL('../../../bin/tui.tsx', import.meta.url),
  ];
  let mod: any;
  let lastImportError: unknown;
  for (const candidate of sourceCandidates) {
    const candidatePath = fileURLToPath(candidate);
    if (!existsSync(candidatePath)) continue;
    try {
      const loaded = await import(candidate.href);
      if (loaded && typeof loaded.runTui === 'function') {
        mod = loaded;
        break;
      }
    } catch (error) {
      lastImportError = error;
    }
  }
  if (!mod) {
    clearTmuxHealthTimer();
    process.off('exit', clearTmuxHealthTimer);
    const suffix = lastImportError instanceof Error ? ` (last import error: ${lastImportError.message})` : '';
    throw new Error(`OpenTUI entry not found: bin/tui.tsx or dist/bin/tui.js${suffix}`);
  }

  try {
    await mod.runTui({
      currentSession: currentSession || undefined,
      currentWindow: currentWindow || undefined,
      runtimeMode: effectiveConfig.runtimeMode || 'tmux',
      getRuntimeBackendStatus,
      initialCommand: options.initialTuiCommand,
      onCommand: async (command: string, append: (line: string) => void): Promise<boolean> => {
        const result = await handleTuiCommand(command, append, {
          session,
          options,
          effectiveConfig,
          getKeepChannelOnStop: () => keepChannelOnStop,
          setKeepChannelOnStop: (value: boolean) => { keepChannelOnStop = value; },
          nextProjectName,
          reloadStateFromDisk,
        });
        return result === 'exit';
      },
      onAttachProject: async (project: string) => {
        reloadStateFromDisk();
        const runtimeTarget = resolveRuntimeWindowForProject(project, effectiveConfig.tmux);
        if (runtimeTarget && session.isSupported() !== false) {
          const focused = await session.focusWindow(runtimeTarget.windowId);
          if (focused) {
            return {
              currentSession: runtimeTarget.sessionName,
              currentWindow: runtimeTarget.windowName,
            };
          }
        }
        if (isPtyRuntimeMode(effectiveConfig.runtimeMode || 'tmux')) {
          return runtimeTarget
            ? {
              currentSession: runtimeTarget.sessionName,
              currentWindow: runtimeTarget.windowName,
            }
            : undefined;
        }
        await attachCommand(project, {
          tmuxSharedSessionName: options.tmuxSharedSessionName,
        });
        if (!runtimeTarget) return;
        return {
          currentSession: runtimeTarget.sessionName,
          currentWindow: runtimeTarget.windowName,
        };
      },
      onStopProject: async (project: string) => {
        await stopCommand(project, {
          keepChannel: keepChannelOnStop,
          tmuxSharedSessionName: options.tmuxSharedSessionName,
        });
      },
      getProjects: async () => {
        reloadStateFromDisk();
        const runtimeWindows = await session.fetchWindows();
        const runtimeSet = new Set(
          (runtimeWindows?.windows || []).map((window) => `${window.sessionName}:${window.windowName}`),
        );

        return stateManager.listProjects().map((project) => {
          const instances = listProjectInstances(project);
          const agentNames = getEnabledAgentNames(project);
          const labels = agentNames.map((agentName) => agentRegistry.get(agentName)?.config.displayName || agentName);
          const primaryInstance = instances[0];
          const window = primaryInstance
            ? resolveProjectWindowName(project, primaryInstance.agentType, effectiveConfig.tmux, primaryInstance.instanceId)
            : '(none)';
          const channelCount = instances.filter((instance) => !!instance.channelId).length;
          const channelBase = channelCount > 0 ? `${channelCount} channel(s)` : 'not connected';
          const windowUp = runtimeWindows
            ? instances.some((instance) => {
              const name = resolveProjectWindowName(project, instance.agentType, effectiveConfig.tmux, instance.instanceId);
              return runtimeSet.has(`${project.tmuxSession}:${name}`);
            })
            : (() => {
              const sessionUp = tmux.sessionExistsFull(project.tmuxSession);
              return sessionUp && instances.some((instance) => {
                const name = resolveProjectWindowName(project, instance.agentType, effectiveConfig.tmux, instance.instanceId);
                return tmux.windowExists(project.tmuxSession, name);
              });
            })();

          return {
            project: project.projectName,
            session: project.tmuxSession,
            window,
            ai: labels.length > 0 ? labels.join(', ') : 'none',
            channel: channelBase,
            open: windowUp,
          };
        });
      },
      getCurrentWindowOutput: async (sessionName: string, windowName: string, width?: number, height?: number) => {
        return session.readWindowOutput(sessionName, windowName, width, height);
      },
      getDaemonLogs: async (maxLines?: number) => {
        const logFile = defaultDaemonManager.getLogFile();
        if (!existsSync(logFile)) {
          return [
            `No daemon log found: ${logFile}`,
            'Start daemon first: discode daemon start',
          ];
        }

        const cap = typeof maxLines === 'number' && Number.isFinite(maxLines)
          ? Math.max(50, Math.min(2000, Math.floor(maxLines)))
          : 500;
        const raw = readFileSync(logFile, 'utf8');
        const lines = raw
          .replace(/\r/g, '')
          .split('\n')
          .filter((line, index, arr) => !(index === arr.length - 1 && line.length === 0));
        return lines.slice(-cap);
      },
      onRuntimeKey: async (sessionName: string, windowName: string, raw: string) => {
        await session.sendRawKey(sessionName, windowName, raw);
      },
      onRuntimeResize: async (sessionName: string, windowName: string, width: number, height: number) => {
        await session.sendResize(sessionName, windowName, width, height);
      },
      onRuntimeFrame: (listener: (frame: {
        sessionName: string;
        windowName: string;
        output: string;
        styled?: import('../../runtime/vt-screen.js').TerminalStyledLine[];
        cursorRow?: number;
        cursorCol?: number;
        cursorVisible?: boolean;
      }) => void) => {
        return session.registerFrameListener(listener);
      },
      getRuntimeStatus: async () => {
        await session.ensureConnected();
        return session.getTransportStatus();
      },
    });
  } finally {
    session.disconnect();
    clearTmuxHealthTimer();
    process.off('exit', clearTmuxHealthTimer);

    if (effectiveConfig.runtimeMode === 'pty') {
      console.log(chalk.cyan('\n📺 Opening terminal...\n'));
      const shell = process.env.SHELL || '/bin/bash';
      const { spawnSync } = await import('child_process');
      spawnSync(shell, [], { stdio: 'inherit' });
    } else if (startedFromTmux && currentSession) {
      console.log(chalk.cyan('\n📺 Returning to terminal...\n'));
      const { attachToTmux } = await import('../common/tmux.js');
      attachToTmux(currentSession, currentWindow || undefined);
    }
  }
}
