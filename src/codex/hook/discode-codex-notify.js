#!/usr/bin/env node

/**
 * Codex notify hook for discode.
 *
 * Codex passes JSON as process.argv[2] (not stdin).
 * Fires on `agent-turn-complete` events and:
 *   1. Parses input-messages to extract tool calls from the current turn
 *   2. Sends tool.activity events for each tool call
 *   3. Sends session.idle with final response text and submitted prompt preview
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

function getStringField(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (var i = 0; i < keys.length; i++) {
    var v = obj[keys[i]];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return "";
}

function getTextFromContent(content) {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    var parts = [];
    for (var i = 0; i < content.length; i++) {
      var text = getTextFromContent(content[i]);
      if (typeof text === "string" && text.length > 0) {
        parts.push(text);
      }
    }
    return parts.join("\n");
  }

  if (!content || typeof content !== "object") return "";

  // OpenAI/Codex variants
  if (typeof content.text === "string") return content.text;
  if (typeof content.input_text === "string") return content.input_text;
  if (typeof content.value === "string") return content.value;

  // Some payload variants may nest actual text in `content`.
  if (typeof content.content === "string") return content.content;
  if (Array.isArray(content.content) || (content.content && typeof content.content === "object")) {
    return getTextFromContent(content.content);
  }

  return "";
}

function getInputMessages(input) {
  var direct = input["input-messages"];
  if (Array.isArray(direct)) return direct;

  var snake = input.input_messages;
  if (Array.isArray(snake)) return snake;

  var camel = input.inputMessages;
  if (Array.isArray(camel)) return camel;

  var messages = input.messages;
  if (Array.isArray(messages)) return messages;

  var nested = input.input && input.input.messages;
  if (Array.isArray(nested)) return nested;

  return [];
}

function getLastAssistantMessage(input) {
  if (typeof input["last-assistant-message"] === "string") return input["last-assistant-message"];
  if (typeof input.last_assistant_message === "string") return input.last_assistant_message;
  if (typeof input.lastAssistantMessage === "string") return input.lastAssistantMessage;
  return "";
}

function getThreadId(input) {
  return getStringField(input, [
    "thread-id",
    "thread_id",
    "threadId",
    "session-id",
    "session_id",
    "sessionId",
  ]);
}

function getSubmittedPromptFromPayload(input) {
  return getStringField(input, [
    "submittedPrompt",
    "submitted_prompt",
    "prompt",
    "promptText",
    "prompt_text",
    "userPrompt",
    "user_prompt",
  ]);
}

function getHistoryPath() {
  if (typeof process.env.CODEX_HISTORY_PATH === "string" && process.env.CODEX_HISTORY_PATH.trim().length > 0) {
    return process.env.CODEX_HISTORY_PATH;
  }
  var home = typeof process.env.HOME === "string" ? process.env.HOME : "";
  if (!home) return "";
  return home + "/.codex/history.jsonl";
}

async function extractPromptFromHistory(threadId) {
  if (!threadId) return "";
  var historyPath = getHistoryPath();
  if (!historyPath) return "";

  try {
    var fs = await import("node:fs");
    if (!fs.existsSync(historyPath)) return "";

    var raw = fs.readFileSync(historyPath, "utf8");
    if (!raw) return "";

    var lines = raw.split("\n");
    for (var i = lines.length - 1; i >= 0; i--) {
      var line = lines[i];
      if (!line) continue;
      var rec = safeParse(line);
      if (
        rec &&
        rec.session_id === threadId &&
        typeof rec.text === "string" &&
        rec.text.trim().length > 0
      ) {
        return rec.text;
      }
    }
  } catch {
    // ignore local history lookup failures
  }

  return "";
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
      var messageText = getTextFromContent(msg.content);
      var hasText = typeof messageText === "string" && messageText.trim().length > 0;
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

/**
 * Extract the latest user prompt text from input-messages.
 * Preserves original text content (no truncation/reformatting).
 */
function extractLatestUserPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";

  for (var i = messages.length - 1; i >= 0; i--) {
    var msg = messages[i];
    if (!msg || msg.role !== "user") continue;

    var promptText = getTextFromContent(msg.content);
    if (typeof promptText === "string" && promptText.trim().length > 0) {
      return promptText;
    }
  }

  return "";
}

async function postToBridge(hostname, port, payload) {
  var headers = { "content-type": "application/json" };
  var token = process.env.DISCODE_HOOK_TOKEN;
  if (token) {
    headers["authorization"] = "Bearer " + token;
  }
  await fetch("http://" + hostname + ":" + port + "/opencode-event", {
    method: "POST",
    headers: headers,
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

  // 1. Extract current-turn prompt + tool calls from input-messages
  var messages = getInputMessages(input);
  var submittedPrompt = extractLatestUserPrompt(messages);
  if (!submittedPrompt) {
    submittedPrompt = getSubmittedPromptFromPayload(input);
  }
  if (!submittedPrompt) {
    var threadId = getThreadId(input);
    submittedPrompt = await extractPromptFromHistory(threadId);
  }
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
  var text = getLastAssistantMessage(input).trim();

  try {
    var idlePayload = Object.assign({}, basePayload, {
      type: "session.idle",
      text: text,
    });
    if (submittedPrompt) idlePayload.submittedPrompt = submittedPrompt;
    await postToBridge(hostname, port, idlePayload);
  } catch {
    // ignore bridge delivery failures
  }
}

main().catch(function () {});
