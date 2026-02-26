#!/usr/bin/env node

/**
 * PostToolUse hook — fires after each tool call.
 * Sends a per-tool thread reply to Slack/Discord so the user
 * can see progress in real time instead of a single batch summary.
 */
var { readStdin, postToBridge } = require("./discode-hook-lib.js");

function shortenPath(fp, maxSegments) {
  var parts = fp.split("/").filter(function (p) { return p.length > 0; });
  if (parts.length <= maxSegments) return parts.join("/");
  return parts.slice(parts.length - maxSegments).join("/");
}

function firstLinePreview(str, maxLen) {
  if (!str) return "";
  var first = str.split("\n")[0].trim();
  if (first.length > maxLen) return first.substring(0, maxLen) + "...";
  return first;
}

function formatToolLine(toolName, toolInput, toolResponse) {
  var input = toolInput && typeof toolInput === "object" ? toolInput : {};
  var response = typeof toolResponse === "string" ? toolResponse : "";

  if (toolName === "Read") {
    var fp = typeof input.file_path === "string" ? input.file_path : "";
    if (!fp) return "";
    return "\uD83D\uDCD6 Read(`" + shortenPath(fp, 4) + "`)";
  }

  if (toolName === "Edit") {
    var fp = typeof input.file_path === "string" ? input.file_path : "";
    if (!fp) return "";
    var short = shortenPath(fp, 4);
    var detail = "";
    var oldStr = typeof input.old_string === "string" ? input.old_string : "";
    var newStr = typeof input.new_string === "string" ? input.new_string : "";
    if (oldStr || newStr) {
      var oldLines = oldStr ? oldStr.split("\n").length : 0;
      var newLines = newStr ? newStr.split("\n").length : 0;
      var delta = newLines - oldLines;
      if (delta > 0) detail = " +" + delta + " lines";
      else if (delta < 0) detail = " " + delta + " lines";
    }
    var preview = firstLinePreview(newStr, 40);
    var previewSuffix = preview ? ' \u2014 "' + preview + '"' : "";
    return "\u270F\uFE0F Edit(`" + short + "`)" + detail + previewSuffix;
  }

  if (toolName === "Write") {
    var fp = typeof input.file_path === "string" ? input.file_path : "";
    if (!fp) return "";
    var short = shortenPath(fp, 4);
    var content = typeof input.content === "string" ? input.content : "";
    var lineCount = content ? content.split("\n").length : 0;
    var countSuffix = lineCount > 0 ? " " + lineCount + " lines" : "";
    return "\uD83D\uDCDD Write(`" + short + "`)" + countSuffix;
  }

  if (toolName === "Bash") {
    var cmd = typeof input.command === "string" ? input.command : "";
    if (!cmd) return "";

    // git commit detection
    if (/\bgit\s+commit\b/.test(cmd) && response) {
      var commitMatch = response.match(/\[[\w/.-]+\s+([a-f0-9]+)\]\s+(.+)/);
      if (commitMatch) {
        var statMatch = response.match(/(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?[^,]*)?(?:,\s+(\d+)\s+deletions?)?/);
        return "GIT_COMMIT:" + JSON.stringify({
          hash: commitMatch[1],
          message: commitMatch[2],
          stat: statMatch ? statMatch[0] : "",
        });
      }
    }

    // git push detection
    if (/\bgit\s+push\b/.test(cmd) && response) {
      var pushMatch = response.match(/([a-f0-9]+)\.\.([a-f0-9]+)\s+(\S+)\s+->\s+(\S+)/);
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

  if (toolName === "Grep") {
    var pattern = typeof input.pattern === "string" ? input.pattern : "";
    if (!pattern) return "";
    var grepPath = typeof input.path === "string" ? shortenPath(input.path, 3) : ".";
    return "\uD83D\uDD0E Grep(`" + pattern + "` in " + grepPath + ")";
  }

  if (toolName === "Glob") {
    var globPattern = typeof input.pattern === "string" ? input.pattern : "";
    if (!globPattern) return "";
    return "\uD83D\uDCC2 Glob(`" + globPattern + "`)";
  }

  if (toolName === "WebSearch") {
    var query = typeof input.query === "string" ? input.query : "";
    if (!query) return "";
    var truncQuery = query.length > 80 ? query.substring(0, 80) + "..." : query;
    return "\uD83C\uDF10 Search(`" + truncQuery + "`)";
  }

  if (toolName === "WebFetch") {
    var url = typeof input.url === "string" ? input.url : "";
    if (!url) return "";
    var truncUrl = url.length > 80 ? url.substring(0, 80) + "..." : url;
    return "\uD83C\uDF10 Fetch(`" + truncUrl + "`)";
  }

  if (toolName === "Task") {
    var desc = typeof input.description === "string" ? input.description : "";
    var subType = typeof input.subagent_type === "string" ? input.subagent_type : "";
    if (!desc) return "";
    return "\uD83E\uDD16 " + subType + "(`" + desc + "`)";
  }

  if (toolName === "TaskCreate") {
    var subject = typeof input.subject === "string" ? input.subject : "";
    if (!subject) return "";
    return "TASK_CREATE:" + JSON.stringify({ subject: subject });
  }

  if (toolName === "TaskUpdate") {
    var taskId = typeof input.taskId === "string" ? input.taskId : "";
    var status = typeof input.status === "string" ? input.status : "";
    if (!taskId) return "";
    return "TASK_UPDATE:" + JSON.stringify({
      taskId: taskId,
      status: status,
      subject: typeof input.subject === "string" ? input.subject : "",
    });
  }

  return "";
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

  var toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  var toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  var toolResponse = typeof input.tool_response === "string" ? input.tool_response : "";

  var line = formatToolLine(toolName, toolInput, toolResponse);
  if (!line) return;

  try {
    await postToBridge(port, {
      projectName: projectName,
      agentType: agentType,
      ...(instanceId ? { instanceId: instanceId } : {}),
      type: "tool.activity",
      text: line,
    });
  } catch (_) {
    // ignore bridge delivery failures
  }
}

main().catch(function () {
  // ignore
});
