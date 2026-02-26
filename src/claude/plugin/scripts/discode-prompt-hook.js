#!/usr/bin/env node

/**
 * UserPromptSubmit hook — fires when a user submits a prompt.
 * Sends the prompt text to the bridge so tmux-initiated prompts
 * are visible in the Discord/Slack channel.
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

  var prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) return;

  var preview = prompt.length > 200 ? prompt.substring(0, 200) + "..." : prompt;

  console.error("[discode-prompt-hook] project=" + projectName + " prompt_len=" + prompt.length);

  try {
    await postToBridge(port, {
      projectName: projectName,
      agentType: agentType,
      ...(instanceId ? { instanceId: instanceId } : {}),
      type: "prompt.submit",
      text: preview,
    });
  } catch (_) {
    // ignore bridge delivery failures
  }
}

main().catch(function () {
  // ignore
});
