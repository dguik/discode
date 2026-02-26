#!/usr/bin/env node
var { readStdin, postToBridge } = require("./discode-hook-lib.js");

async function main() {
  const inputRaw = await readStdin();
  let input = {};
  try {
    input = inputRaw ? JSON.parse(inputRaw) : {};
  } catch {
    input = {};
  }

  const projectName = process.env.DISCODE_PROJECT || process.env.AGENT_DISCORD_PROJECT || "";
  if (!projectName) return;

  const agentType = process.env.DISCODE_AGENT || process.env.AGENT_DISCORD_AGENT || "claude";
  const instanceId = process.env.DISCODE_INSTANCE || process.env.AGENT_DISCORD_INSTANCE || "";
  const port = process.env.DISCODE_PORT || process.env.AGENT_DISCORD_PORT || "18470";

  const hookEventName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";

  if (hookEventName === "SessionStart") {
    const source = typeof input.source === "string" ? input.source : "unknown";
    const model = typeof input.model === "string" ? input.model : "";

    console.error(`[discode-session-hook] project=${projectName} event=start source=${source} model=${model}`);

    try {
      await postToBridge(port, {
        projectName,
        agentType,
        ...(instanceId ? { instanceId } : {}),
        type: "session.start",
        source,
        model,
      });
    } catch {
      // ignore bridge delivery failures
    }
    return;
  }

  if (hookEventName === "SessionEnd") {
    const reason = typeof input.reason === "string" ? input.reason : "unknown";

    console.error(`[discode-session-hook] project=${projectName} event=end reason=${reason}`);

    try {
      await postToBridge(port, {
        projectName,
        agentType,
        ...(instanceId ? { instanceId } : {}),
        type: "session.end",
        reason,
      });
    } catch {
      // ignore bridge delivery failures
    }
    return;
  }

  console.error(`[discode-session-hook] project=${projectName} unknown hook_event_name=${hookEventName}`);
}

main().catch(() => {
  // ignore
});
