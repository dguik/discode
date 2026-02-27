/**
 * Shared library for discode hook scripts.
 *
 * Contains functions duplicated across stop-hook, notification-hook,
 * subagent-hook, tool-hook, and session-hook.
 */
const { openSync, readSync, closeSync, statSync } = require("fs");

function asObject(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  return node;
}

function parseLineJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readTail(filePath, maxBytes) {
  try {
    const st = statSync(filePath);
    if (st.size === 0) return "";
    const readSize = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(readSize);
    const fd = openSync(filePath, "r");
    try {
      readSync(fd, buf, 0, readSize, st.size - readSize);
    } finally {
      closeSync(fd);
    }
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

function extractToolUseBlocks(node, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 10 || node === undefined || node === null) return [];

  if (Array.isArray(node)) {
    return node.flatMap(function (item) { return extractToolUseBlocks(item, depth + 1); });
  }

  var obj = asObject(node);
  if (!obj) return [];

  if (obj.type === "tool_use" && typeof obj.name === "string") {
    return [{ name: obj.name, input: obj.input && typeof obj.input === "object" ? obj.input : {} }];
  }

  if (Array.isArray(obj.content)) {
    return extractToolUseBlocks(obj.content, depth + 1);
  }

  return [];
}

function formatPromptText(toolUseBlocks) {
  var parts = [];
  for (var i = 0; i < toolUseBlocks.length; i++) {
    var block = toolUseBlocks[i];
    if (block.name === "AskUserQuestion") {
      var input = block.input || {};
      var questions = Array.isArray(input.questions) ? input.questions : [];
      for (var qi = 0; qi < questions.length; qi++) {
        var qObj = asObject(questions[qi]);
        if (!qObj) continue;
        var header = typeof qObj.header === "string" ? qObj.header : "";
        var question = typeof qObj.question === "string" ? qObj.question : "";
        if (!question) continue;

        var text = header ? "\u2753 *" + header + "*\n" + question : "\u2753 " + question;
        var options = Array.isArray(qObj.options) ? qObj.options : [];
        for (var oi = 0; oi < options.length; oi++) {
          var optObj = asObject(options[oi]);
          if (!optObj) continue;
          var label = typeof optObj.label === "string" ? optObj.label : "";
          var desc = typeof optObj.description === "string" ? optObj.description : "";
          if (!label) continue;
          text += desc ? "\n\u2022 *" + label + "* \u2014 " + desc : "\n\u2022 *" + label + "*";
        }
        parts.push(text);
      }
    } else if (block.name === "ExitPlanMode") {
      parts.push("\uD83D\uDCCB Plan approval needed");
    }
  }
  return parts.join("\n\n");
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

function postToBridge(port, payload) {
  var hostname = process.env.DISCODE_HOSTNAME || process.env.AGENT_DISCORD_HOSTNAME || "127.0.0.1";
  var headers = { "content-type": "application/json" };
  var token = process.env.DISCODE_HOOK_TOKEN;
  if (token) {
    headers["authorization"] = "Bearer " + token;
  }
  return fetch("http://" + hostname + ":" + port + "/opencode-event", {
    method: "POST",
    headers: headers,
    body: JSON.stringify(payload),
  });
}

module.exports = {
  asObject: asObject,
  parseLineJson: parseLineJson,
  readTail: readTail,
  extractToolUseBlocks: extractToolUseBlocks,
  formatPromptText: formatPromptText,
  readStdin: readStdin,
  postToBridge: postToBridge,
};
