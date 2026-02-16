// @ts-nocheck

export const AgentDiscordBridgePlugin = async () => {
  let lastAssistantText = "";
  let latestAssistantMessageId = "";
  /** @type {Set<string>} */
  const assistantMessageIds = new Set();
  /** @type {Map<string, { order: string[]; parts: Record<string, string> }>} */
  const assistantTextByMessage = new Map();

  const projectName = process.env.AGENT_DISCORD_PROJECT || "";
  const agentType = process.env.AGENT_DISCORD_AGENT || "opencode";
  const instanceId = process.env.AGENT_DISCORD_INSTANCE || "";
  const port = process.env.AGENT_DISCORD_PORT || "18470";
  const endpoint = "http://127.0.0.1:" + port + "/opencode-event";

  /** @param {Record<string, unknown>} payload */
  const post = async (payload) => {
    if (!projectName) return;
    try {
      await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectName,
          agentType,
          ...(instanceId ? { instanceId } : {}),
          ...payload,
        }),
      });
    } catch {
      // ignore bridge delivery failures
    }
  };

  /** @param {unknown} node */
  const toObject = (node) => {
    if (!node || typeof node !== "object") return null;
    return /** @type {Record<string, unknown>} */ (node);
  };

  /** @param {unknown} node @param {number} [depth=0] */
  const textFromNode = (node, depth = 0) => {
    if (depth > 10 || node === undefined || node === null) return "";
    if (typeof node === "string") return node;
    if (typeof node === "number" || typeof node === "boolean") return String(node);
    if (Array.isArray(node)) {
      return node
        .map((item) => textFromNode(item, depth + 1))
        .filter((item) => item.length > 0)
        .join("\n");
    }

    const obj = toObject(node);
    if (!obj) return "";
    if (obj.type === "text" && typeof obj.text === "string") return obj.text;

    return Object.values(obj)
      .map((value) => textFromNode(value, depth + 1))
      .filter((item) => item.length > 0)
      .join("\n");
  };

  /** @param {unknown} event */
  const getProperties = (event) => {
    const obj = toObject(event);
    if (!obj) return {};
    return toObject(obj.properties) || {};
  };

  /** @param {unknown} info */
  const rememberAssistantMessage = (info) => {
    const obj = toObject(info);
    if (!obj) return;
    if (obj.role !== "assistant") return;
    if (typeof obj.id !== "string" || obj.id.length === 0) return;

    assistantMessageIds.add(obj.id);
    latestAssistantMessageId = obj.id;
  };

  /** @param {unknown} part @param {unknown} delta */
  const updateAssistantTextPart = (part, delta) => {
    const obj = toObject(part);
    if (!obj) return;
    if (obj.type !== "text") return;

    const messageID = typeof obj.messageID === "string" ? obj.messageID : "";
    if (!messageID || !assistantMessageIds.has(messageID)) return;

    const partID = typeof obj.id === "string" && obj.id.length > 0 ? obj.id : "__default__";
    const current = assistantTextByMessage.get(messageID) || { order: [], parts: {} };
    if (!current.parts[partID]) {
      current.order.push(partID);
    }

    const nextText = typeof obj.text === "string" ? obj.text.trim() : "";
    if (nextText.length > 0) {
      current.parts[partID] = nextText;
    } else if (typeof delta === "string" && delta.length > 0) {
      current.parts[partID] = (current.parts[partID] || "") + delta;
    } else {
      return;
    }

    assistantTextByMessage.set(messageID, current);
    latestAssistantMessageId = messageID;

    const joined = current.order
      .map((id) => current.parts[id])
      .filter((item) => typeof item === "string" && item.length > 0)
      .join("\n\n")
      .trim();
    if (joined) {
      lastAssistantText = joined;
    }
  };

  const getLatestAssistantText = () => {
    if (!latestAssistantMessageId) return lastAssistantText;
    const current = assistantTextByMessage.get(latestAssistantMessageId);
    if (!current) return lastAssistantText;
    const joined = current.order
      .map((id) => current.parts[id])
      .filter((item) => typeof item === "string" && item.length > 0)
      .join("\n\n")
      .trim();
    return joined || lastAssistantText;
  };

  return {
    /** @param {{ event?: unknown }} input */
    event: async ({ event }) => {
      const eventObj = toObject(event);
      if (!eventObj) return;

      const properties = getProperties(eventObj);
      const eventType = typeof eventObj.type === "string" ? eventObj.type : "";

      if (eventType === "message.updated") {
        rememberAssistantMessage(properties.info || eventObj.info || eventObj.message);
      }

      if (eventType === "message.part.updated") {
        updateAssistantTextPart(properties.part || eventObj.part, properties.delta || eventObj.delta);
      }

      if (eventType === "session.error") {
        const errorText = textFromNode(properties.error || eventObj.error || eventObj).trim();
        await post({ type: "session.error", text: errorText || "unknown error" });
        return;
      }

      if (eventType === "session.idle") {
        const latestText = getLatestAssistantText().trim();
        await post({ type: "session.idle", text: latestText });
      }
    },
  };
};
