#!/usr/bin/env node
var { asObject, extractToolUseBlocks, formatPromptText, parseLineJson, readTail, readStdin, postToBridge } = require("./discode-hook-lib.js");

/**
 * Extract promptText from the transcript tail.
 * Scans backwards from the end, collecting tool_use blocks from assistant
 * entries until a real user message (with text content) is reached.
 */
function extractPromptFromTranscript(transcriptPath) {
  if (!transcriptPath) return "";

  const tail = readTail(transcriptPath, 65536);
  if (!tail) return "";

  const lines = tail.split("\n");
  const allToolUseBlocks = [];

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const entry = parseLineJson(line);
    if (!entry) continue;

    const obj = asObject(entry);
    if (!obj) continue;

    // Stop at real user messages (with text content, not tool_result)
    if (obj.type === "user") {
      const message = asObject(obj.message) || obj;
      const content = Array.isArray(message.content) ? message.content : [];
      const hasUserText = content.some((c) => {
        const co = asObject(c);
        return co && co.type === "text";
      });
      if (hasUserText) break;
      continue;
    }

    if (obj.type !== "assistant") continue;

    const message = asObject(obj.message) || obj;
    const toolUse = extractToolUseBlocks(message.content);
    if (toolUse.length > 0) {
      allToolUseBlocks.push(...toolUse);
    }
  }

  allToolUseBlocks.reverse();
  return formatPromptText(allToolUseBlocks);
}

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

  const message = typeof input.message === "string" ? input.message.trim() : "";
  const notificationType = typeof input.notification_type === "string" ? input.notification_type : "unknown";
  const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : "";

  const promptText = extractPromptFromTranscript(transcriptPath);

  console.error(`[discode-notification-hook] project=${projectName} type=${notificationType} message=${message.substring(0, 100)} prompt_len=${promptText.length}`);

  try {
    await postToBridge(port, {
      projectName,
      agentType,
      ...(instanceId ? { instanceId } : {}),
      type: "session.notification",
      notificationType,
      text: message,
      ...(promptText ? { promptText } : {}),
    });
  } catch {
    // ignore bridge delivery failures
  }
}

main().catch(() => {
  // ignore
});
