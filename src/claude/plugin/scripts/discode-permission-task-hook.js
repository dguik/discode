#!/usr/bin/env node
var { readStdin, postToBridge } = require("./discode-hook-lib.js");

function truncateInput(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  if (toolName === "Bash" && typeof toolInput.command === "string") {
    var cmd = toolInput.command;
    return cmd.length > 100 ? cmd.slice(0, 100) + "..." : cmd;
  }
  if ((toolName === "Edit" || toolName === "Write" || toolName === "Read") && typeof toolInput.file_path === "string") {
    return toolInput.file_path;
  }
  var keys = Object.keys(toolInput);
  if (keys.length === 0) return "";
  var first = toolInput[keys[0]];
  if (typeof first === "string") {
    return first.length > 100 ? first.slice(0, 100) + "..." : first;
  }
  return "";
}

async function main() {
  var inputRaw = await readStdin();
  var input = {};
  try {
    input = inputRaw ? JSON.parse(inputRaw) : {};
  } catch {
    input = {};
  }

  var projectName = process.env.DISCODE_PROJECT || process.env.AGENT_DISCORD_PROJECT || "";
  if (!projectName) return;

  var agentType = process.env.DISCODE_AGENT || process.env.AGENT_DISCORD_AGENT || "claude";
  var instanceId = process.env.DISCODE_INSTANCE || process.env.AGENT_DISCORD_INSTANCE || "";
  var port = process.env.DISCODE_PORT || process.env.AGENT_DISCORD_PORT || "18470";

  var hookEventName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";

  if (hookEventName === "PermissionRequest") {
    var toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    var toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
    var toolInputPreview = truncateInput(toolName, toolInput);

    console.error("[discode-permission-task-hook] project=" + projectName + " event=permission tool=" + toolName);

    try {
      await postToBridge(port, {
        projectName: projectName,
        agentType: agentType,
        ...(instanceId ? { instanceId: instanceId } : {}),
        type: "permission.request",
        toolName: toolName,
        toolInput: toolInputPreview,
      });
    } catch {
      // ignore bridge delivery failures
    }
    return;
  }

  if (hookEventName === "TaskCompleted") {
    var taskId = typeof input.task_id === "string" ? input.task_id : "";
    var taskSubject = typeof input.task_subject === "string" ? input.task_subject : "";
    var teammateName = typeof input.teammate_name === "string" ? input.teammate_name : "";

    console.error("[discode-permission-task-hook] project=" + projectName + " event=task.completed taskId=" + taskId);

    try {
      await postToBridge(port, {
        projectName: projectName,
        agentType: agentType,
        ...(instanceId ? { instanceId: instanceId } : {}),
        type: "task.completed",
        taskId: taskId,
        taskSubject: taskSubject,
        ...(teammateName ? { teammateName: teammateName } : {}),
      });
    } catch {
      // ignore bridge delivery failures
    }
    return;
  }

  console.error("[discode-permission-task-hook] project=" + projectName + " unknown hook_event_name=" + hookEventName);
}

main().catch(function () {
  // ignore
});
