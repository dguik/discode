import { spawn } from 'child_process';
import { platform, release } from 'os';
import type { CliRenderer } from '@opentui/core';

type ClipboardRenderer = Pick<CliRenderer, 'copyToClipboardOSC52'>;

function writeOsc52(text: string, renderer?: ClipboardRenderer): void {
  if (!text || text.length === 0) return;
  if (renderer?.copyToClipboardOSC52(text)) return;
  if (!process.stdout.isTTY) return;

  const base64 = Buffer.from(text).toString('base64');
  const osc52 = `\x1b]52;c;${base64}\x07`;
  const passthrough = Boolean(process.env.TMUX || process.env.STY);
  const sequence = passthrough ? `\x1bPtmux;\x1b${osc52}\x1b\\` : osc52;
  process.stdout.write(sequence);
}

function pipeToClipboard(command: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    let child;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch {
      finish(false);
      return;
    }

    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));

    if (!child.stdin) {
      finish(false);
      return;
    }

    child.stdin.on('error', () => finish(false));
    child.stdin.end(text, 'utf8');
  });
}

async function copyWithNativeTools(text: string): Promise<void> {
  const os = platform();
  const isWsl = release().toLowerCase().includes('microsoft');

  if (os === 'darwin') {
    if (await pipeToClipboard('pbcopy', [], text)) return;
  }

  if (os === 'linux') {
    if (process.env.WAYLAND_DISPLAY && (await pipeToClipboard('wl-copy', [], text))) return;
    if (await pipeToClipboard('xclip', ['-selection', 'clipboard'], text)) return;
    if (await pipeToClipboard('xsel', ['--clipboard', '--input'], text)) return;
  }

  if (os === 'win32' || isWsl) {
    if (await pipeToClipboard('clip.exe', [], text)) return;
    await pipeToClipboard(
      'powershell.exe',
      [
        '-NonInteractive',
        '-NoProfile',
        '-Command',
        '[Console]::InputEncoding=[Text.UTF8Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())',
      ],
      text
    );
  }
}

export async function copyTextToClipboard(text: string, renderer?: ClipboardRenderer): Promise<void> {
  if (!text || text.length === 0) return;
  writeOsc52(text, renderer);
  await copyWithNativeTools(text);
}
