#!/usr/bin/env node

/**
 * SubagentStop hook — fires when a subagent (Task tool) completes.
 * Sends a summary to Slack/Discord so the user can track parallel work.
 */

function truncate(str, maxLen) {
  if (!str) return "";
  var lines = str.trim().split("\n").filter(function (l) { return l.trim().length > 0; });
  var preview = lines.slice(0, 2).join(" ").trim();
  if (preview.length > maxLen) return preview.substring(0, maxLen) + "...";
  return preview;
}

function readStdin() {
  return new Promise(function (resolve) {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    var raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", function (chunk) {
      raw += chunk;
    });
    process.stdin.on("end", function () {
      resolve(raw);
    });
    process.stdin.on("error", function () {
      resolve("");
    });
  });
}

async function postToBridge(port, payload) {
  var hostname = process.env.DISCODE_HOSTNAME || process.env.AGENT_DISCORD_HOSTNAME || "127.0.0.1";
  await fetch("http://" + hostname + ":" + port + "/opencode-event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function main() {
  var inputRaw = await readStdin();
  var input = {};
  try {
    input = inputRaw ? JSON.parse(inputRaw) : {};
  } catch (_) {
    input = {};
  }

  var projectName = process.env.DISCODE_PROJECT || process.env.AGENT_DISCORD_PROJECT || "";
  if (!projectName) return;

  var agentType = process.env.DISCODE_AGENT || process.env.AGENT_DISCORD_AGENT || "claude";
  var instanceId = process.env.DISCODE_INSTANCE || process.env.AGENT_DISCORD_INSTANCE || "";
  var port = process.env.DISCODE_PORT || process.env.AGENT_DISCORD_PORT || "18470";

  var subagentType = typeof input.agent_type === "string" ? input.agent_type : "unknown";
  var lastMessage = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";

  var summary = truncate(lastMessage, 200);
  if (!summary) return;

  try {
    await postToBridge(port, {
      projectName: projectName,
      agentType: agentType,
      ...(instanceId ? { instanceId: instanceId } : {}),
      type: "tool.activity",
      text: "SUBAGENT_DONE:" + JSON.stringify({ subagentType: subagentType, summary: summary }),
    });
  } catch (_) {
    // ignore bridge delivery failures
  }
}

main().catch(function () {
  // ignore
});
