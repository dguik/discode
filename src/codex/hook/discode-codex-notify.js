#!/usr/bin/env node

/**
 * Codex notify hook for discode.
 *
 * Codex passes JSON as process.argv[2] (not stdin).
 * Fires on `agent-turn-complete` events and:
 *   1. Parses input-messages to extract tool calls from the current turn
 *   2. Sends tool.activity events for each tool call
 *   3. Sends session.idle with the final response text
 */

function shortenPath(fp, maxSegments) {
  var parts = fp.split("/").filter(function (p) { return p.length > 0; });
  if (parts.length <= maxSegments) return parts.join("/");
  return parts.slice(parts.length - maxSegments).join("/");
}

function safeParse(str) {
  if (typeof str === "object" && str !== null) return str;
  if (typeof str !== "string") return {};
  try { return JSON.parse(str); } catch { return {}; }
}

function parseApplyPatch(patchStr) {
  if (typeof patchStr !== "string") return null;
  var lines = patchStr.split("\n");
  var filePath = "";
  var additions = 0;
  var deletions = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.indexOf("+++ b/") === 0 && !filePath) {
      filePath = line.slice(6);
    } else if (line.charAt(0) === "+" && line.indexOf("+++") !== 0) {
      additions++;
    } else if (line.charAt(0) === "-" && line.indexOf("---") !== 0) {
      deletions++;
    }
  }
  return { filePath: filePath, additions: additions, deletions: deletions };
}

function formatCodexToolLine(toolName, argsStr, resultStr) {
  var args = safeParse(argsStr);
  var result = typeof resultStr === "string" ? resultStr : "";

  if (toolName === "shell") {
    var cmd = "";
    if (Array.isArray(args.command)) {
      cmd = args.command.join(" ");
    } else if (typeof args.command === "string") {
      cmd = args.command;
    }
    if (!cmd) return "";

    // git commit detection
    if (/\bgit\s+commit\b/.test(cmd) && result) {
      var commitMatch = result.match(/\[[\w/.-]+\s+([a-f0-9]+)\]\s+(.+)/);
      if (commitMatch) {
        var statMatch = result.match(/(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?[^,]*)?(?:,\s+(\d+)\s+deletions?)?/);
        return "GIT_COMMIT:" + JSON.stringify({
          hash: commitMatch[1],
          message: commitMatch[2],
          stat: statMatch ? statMatch[0] : "",
        });
      }
    }

    // git push detection
    if (/\bgit\s+push\b/.test(cmd) && result) {
      var pushMatch = result.match(/([a-f0-9]+)\.\.([a-f0-9]+)\s+(\S+)\s+->\s+(\S+)/);
      if (pushMatch) {
        return "GIT_PUSH:" + JSON.stringify({
          toHash: pushMatch[2],
          remoteRef: pushMatch[4],
        });
      }
    }

    var truncated = cmd.length > 100 ? cmd.substring(0, 100) + "..." : cmd;
    return "\uD83D\uDCBB `" + truncated + "`";
  }

  if (toolName === "apply_patch") {
    var patch = typeof args.patch === "string" ? args.patch :
                typeof args.diff === "string" ? args.diff : "";
    if (!patch) return "\u270F\uFE0F Edit(unknown)";
    var info = parseApplyPatch(patch);
    if (!info || !info.filePath) return "\u270F\uFE0F Edit(unknown)";
    var short = shortenPath(info.filePath, 4);
    var delta = info.additions - info.deletions;
    var detail = "";
    if (delta > 0) detail = " +" + delta + " lines";
    else if (delta < 0) detail = " " + delta + " lines";
    else if (info.additions > 0) detail = " \u00B1" + info.additions + " lines";
    return "\u270F\uFE0F Edit(`" + short + "`)" + detail;
  }

  if (toolName === "read_file" || toolName === "container.read_file") {
    var fp = typeof args.file_path === "string" ? args.file_path :
             typeof args.path === "string" ? args.path : "";
    if (!fp) return "";
    return "\uD83D\uDCD6 Read(`" + shortenPath(fp, 4) + "`)";
  }

  if (toolName === "create_file" || toolName === "container.create_file") {
    var fp = typeof args.file_path === "string" ? args.file_path :
             typeof args.path === "string" ? args.path : "";
    if (!fp) return "";
    var content = typeof args.content === "string" ? args.content :
                  typeof args.contents === "string" ? args.contents : "";
    var lineCount = content ? content.split("\n").length : 0;
    var countSuffix = lineCount > 0 ? " " + lineCount + " lines" : "";
    return "\uD83D\uDCDD Write(`" + shortenPath(fp, 4) + "`)" + countSuffix;
  }

  if (toolName === "list_dir" || toolName === "container.list_dir") {
    var dirPath = typeof args.path === "string" ? args.path : ".";
    return "\uD83D\uDCC2 List(`" + shortenPath(dirPath, 3) + "`)";
  }

  if (toolName) {
    return "\u2699\uFE0F " + toolName;
  }

  return "";
}

/**
 * Extract current turn's tool calls from input-messages (OpenAI API format).
 * Walks backwards from the end to find the last user message with text content,
 * then collects all tool_calls from assistant messages after that point.
 */
function extractCurrentTurnTools(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  var turnStartIndex = 0;
  for (var i = messages.length - 1; i >= 0; i--) {
    var msg = messages[i];
    if (msg.role === "user") {
      var hasText = typeof msg.content === "string" && msg.content.trim().length > 0;
      if (!hasText && Array.isArray(msg.content)) {
        for (var j = 0; j < msg.content.length; j++) {
          if (msg.content[j] && msg.content[j].type === "text" && msg.content[j].text) {
            hasText = true;
            break;
          }
        }
      }
      if (hasText) {
        turnStartIndex = i + 1;
        break;
      }
    }
  }

  // Build tool_call_id -> tool response map
  var toolResponses = {};
  for (var i = turnStartIndex; i < messages.length; i++) {
    var msg = messages[i];
    if (msg.role === "tool" && msg.tool_call_id) {
      toolResponses[msg.tool_call_id] = typeof msg.content === "string" ? msg.content : "";
    }
  }

  // Collect tool calls from assistant messages
  var toolCalls = [];
  for (var i = turnStartIndex; i < messages.length; i++) {
    var msg = messages[i];
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (var j = 0; j < msg.tool_calls.length; j++) {
        var tc = msg.tool_calls[j];
        if (tc && tc.function) {
          toolCalls.push({
            name: tc.function.name || "",
            arguments: tc.function.arguments || "",
            result: toolResponses[tc.id] || "",
          });
        }
      }
    }
  }

  return toolCalls;
}

async function postToBridge(hostname, port, payload) {
  await fetch("http://" + hostname + ":" + port + "/opencode-event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function main() {
  var input = {};
  try {
    input = JSON.parse(process.argv[2] || "{}");
  } catch {
    input = {};
  }

  if (input.type !== "agent-turn-complete") {
    return;
  }

  var projectName = process.env.DISCODE_PROJECT || process.env.AGENT_DISCORD_PROJECT || "";
  if (!projectName) return;

  var agentType = process.env.DISCODE_AGENT || process.env.AGENT_DISCORD_AGENT || "codex";
  var instanceId = process.env.DISCODE_INSTANCE || process.env.AGENT_DISCORD_INSTANCE || "";
  var port = process.env.DISCODE_PORT || process.env.AGENT_DISCORD_PORT || "18470";
  var hostname = process.env.DISCODE_HOSTNAME || process.env.AGENT_DISCORD_HOSTNAME || "127.0.0.1";

  var basePayload = {
    projectName: projectName,
    agentType: agentType,
  };
  if (instanceId) basePayload.instanceId = instanceId;

  // 1. Extract and send tool.activity events from input-messages
  var messages = Array.isArray(input["input-messages"]) ? input["input-messages"] : [];
  var toolCalls = extractCurrentTurnTools(messages);

  for (var i = 0; i < toolCalls.length; i++) {
    var tc = toolCalls[i];
    var line = formatCodexToolLine(tc.name, tc.arguments, tc.result);
    if (!line) continue;
    try {
      await postToBridge(hostname, port, Object.assign({}, basePayload, {
        type: "tool.activity",
        text: line,
      }));
    } catch {
      // ignore bridge delivery failures
    }
  }

  // 2. Send session.idle with final response text
  var text = typeof input["last-assistant-message"] === "string"
    ? input["last-assistant-message"].trim()
    : "";

  try {
    await postToBridge(hostname, port, Object.assign({}, basePayload, {
      type: "session.idle",
      text: text,
    }));
  } catch {
    // ignore bridge delivery failures
  }
}

main().catch(function () {});
