#!/usr/bin/env node

/**
 * SubagentStop hook — fires when a subagent (Task tool) completes.
 * Sends a summary to Slack/Discord so the user can track parallel work.
 */
var { readStdin, postToBridge } = require("./discode-hook-lib.js");

function truncate(str, maxLen) {
  if (!str) return "";
  var lines = str.trim().split("\n").filter(function (l) { return l.trim().length > 0; });
  var preview = lines.slice(0, 2).join(" ").trim();
  if (preview.length > maxLen) return preview.substring(0, maxLen) + "...";
  return preview;
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

  var subagentType = typeof input.agent_type === "string" ? input.agent_type : "";
  // Skip when agent_type is empty — these are suggested next prompts, not real subagents
  if (!subagentType) return;

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
