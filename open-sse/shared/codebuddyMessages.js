/**
 * Shared message normalization for the CodeBuddy-family gateways
 * (codebuddy-intl, workbuddy) — both are stream-only OpenAI-compatible
 * endpoints that reject a bare OpenAI shape:
 *
 *  - WorkBuddy answers 11128 "first message is not system prompt".
 *  - codebuddy-intl answers 11101 invalid request.
 *
 * Both therefore need a leading `system` message and typed-block user content.
 *
 * The previous normalization replaced the *entire* messages array with a
 * single `"You are CodeBuddy Code."` system message and `continue`d past
 * every incoming `system`/`developer` message. That erased the client's real
 * system prompt: for a coding agent the system prompt carries its identity
 * and its whole tool catalog, so the model ran without knowing its own tools
 * (e.g. it could not see its MCP servers) while still answering normally.
 *
 * Keep the leading system message the gateway requires, but make the client's
 * own system prompt that leading message. The generic marker is only a
 * fallback for requests that carry no system prompt at all — prefixing it
 * unconditionally would put a false identity in the most prominent position
 * and the model would adopt it.
 *
 * Set CODEBUDDY_NEUTRALIZE_SYSTEM=1 to restore the old drop-everything
 * behavior, e.g. if a gateway content filter rejects a long agent prompt.
 */

export const CODEBUDDY_SYSTEM_MARKER = "You are CodeBuddy Code.";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function shouldNeutralize() {
  return TRUTHY.has(String(process.env.CODEBUDDY_NEUTRALIZE_SYSTEM || "").toLowerCase());
}

/** Flatten string | typed-block content to plain text. */
export function flattenMessageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Rebuild an OpenAI message array for the CodeBuddy-family gateways.
 *
 * @param {Array} messages incoming OpenAI-shaped messages
 * @returns {Array} `[leading system message, ...conversation]`
 */
export function buildCodebuddyMessages(messages) {
  const source = Array.isArray(messages) ? messages : [];
  const rest = [];
  const systemParts = [];

  for (const message of source) {
    if (!message || typeof message !== "object") continue;

    const isSystem = message.role === "system" || message.role === "developer";
    if (isSystem) {
      if (shouldNeutralize()) continue;
      const text = flattenMessageText(message.content);
      if (text.trim()) systemParts.push(text);
      continue;
    }

    if (message.role === "user" && typeof message.content === "string") {
      rest.push({ ...message, content: [{ type: "text", text: message.content }] });
    } else {
      rest.push({ ...message });
    }
  }

  // The gateway requires a leading system message (11101 / 11128). The client's
  // own system prompt satisfies that requirement on its own; the generic marker
  // is only used when the client sent none.
  const leading = systemParts.length > 0 ? systemParts.join("\n\n") : CODEBUDDY_SYSTEM_MARKER;

  return [{ role: "system", content: leading }, ...rest];
}
