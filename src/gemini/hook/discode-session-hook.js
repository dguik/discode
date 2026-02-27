#!/usr/bin/env node

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => {
      resolve(raw);
    });
    process.stdin.on('error', () => {
      resolve('');
    });
  });
}

async function postToBridge(hostname, port, payload) {
  var headers = { 'content-type': 'application/json' };
  var token = process.env.DISCODE_HOOK_TOKEN;
  if (token) {
    headers['authorization'] = 'Bearer ' + token;
  }
  await fetch('http://' + hostname + ':' + port + '/opencode-event', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(payload),
  });
}

async function main() {
  const inputRaw = await readStdin();
  let input = {};
  try {
    input = inputRaw ? JSON.parse(inputRaw) : {};
  } catch {
    input = {};
  }

  const projectName = process.env.DISCODE_PROJECT || process.env.AGENT_DISCORD_PROJECT || '';
  if (!projectName) {
    process.stdout.write('{}');
    return;
  }

  const agentType = process.env.DISCODE_AGENT || process.env.AGENT_DISCORD_AGENT || 'gemini';
  const instanceId = process.env.DISCODE_INSTANCE || process.env.AGENT_DISCORD_INSTANCE || '';
  const port = process.env.DISCODE_PORT || process.env.AGENT_DISCORD_PORT || '18470';
  const hostname = process.env.DISCODE_HOSTNAME || process.env.AGENT_DISCORD_HOSTNAME || '127.0.0.1';

  const hookEventName = typeof input.hook_event_name === 'string' ? input.hook_event_name : '';

  if (hookEventName === 'SessionStart') {
    const source = typeof input.source === 'string' ? input.source : 'unknown';
    console.error(`[discode-session-hook] project=${projectName} event=SessionStart source=${source}`);
    try {
      await postToBridge(hostname, port, {
        projectName,
        agentType,
        ...(instanceId ? { instanceId } : {}),
        type: 'session.start',
        source,
        model: '',
      });
    } catch {
      // ignore bridge delivery failures
    }
    process.stdout.write('{}');
    return;
  }

  if (hookEventName === 'SessionEnd') {
    const reason = typeof input.reason === 'string' ? input.reason : 'unknown';
    console.error(`[discode-session-hook] project=${projectName} event=SessionEnd reason=${reason}`);
    try {
      await postToBridge(hostname, port, {
        projectName,
        agentType,
        ...(instanceId ? { instanceId } : {}),
        type: 'session.end',
        reason,
      });
    } catch {
      // ignore bridge delivery failures
    }
    process.stdout.write('{}');
    return;
  }

  // Unknown hook_event_name — do nothing
  process.stdout.write('{}');
}

main().catch(() => {
  process.stdout.write('{}');
});
