#!/usr/bin/env node

/**
 * TeammateIdle hook — fires when a teammate in Agent Teams becomes idle.
 * Sends an idle notification to the bridge for remote monitoring.
 */
var { readStdin, postToBridge } = require("./discode-hook-lib.js");

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

  var teammateName = typeof input.teammate_name === "string" ? input.teammate_name : "";
  var teamName = typeof input.team_name === "string" ? input.team_name : "";

  if (!teammateName) return;

  console.error("[discode-teammate-hook] project=" + projectName + " teammate=" + teammateName);

  try {
    await postToBridge(port, {
      projectName: projectName,
      agentType: agentType,
      ...(instanceId ? { instanceId: instanceId } : {}),
      type: "teammate.idle",
      teammateName: teammateName,
      ...(teamName ? { teamName: teamName } : {}),
    });
  } catch (_) {
    // ignore bridge delivery failures
  }
}

main().catch(function () {
  // ignore
});
