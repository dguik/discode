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
  const raw = await readStdin();

  let input = {};
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }

  if (input.stop_hook_active === true) {
    process.stdout.write('{}');
    return;
  }

  if (typeof input.hook_event_name === 'string' && input.hook_event_name !== 'AfterAgent') {
    process.stdout.write('{}');
    return;
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
  const text = typeof input.prompt_response === 'string' ? input.prompt_response.trim() : '';

  try {
    await postToBridge(hostname, port, {
      projectName,
      agentType,
      ...(instanceId ? { instanceId } : {}),
      type: 'session.idle',
      text,
    });
  } catch {
    // ignore bridge delivery failures
  }

  process.stdout.write('{}');
}

main().catch(() => {
  process.stdout.write('{}');
});
