import { DefaultExecutor } from "./default.js";
import { workbuddyChatHeaders } from "../config/workbuddy.js";

/**
 * WorkBuddyExecutor — talks to https://www.workbuddy.ai/v2/chat/completions
 *
 * Same stream-only OpenAI-compatible gateway as CodeBuddy, plus two behaviours
 * captured from the bundled CLI's wire traffic:
 *
 *  - The gateway rejects a bare OpenAI shape with 11128 "first message is not
 *    system prompt", so a leading system message is always prepended and user
 *    content is sent as typed blocks.
 *  - x-user-id carries the account sub; the gateway scopes billing to it.
 */
export class WorkBuddyExecutor extends DefaultExecutor {
  constructor() {
    super("workbuddy");
  }

  buildHeaders(credentials, stream = true) {
    const headers = super.buildHeaders(credentials, stream);
    const userAgent = headers["User-Agent"];
    for (const [k, v] of Object.entries(workbuddyChatHeaders())) {
      if (headers[k] === undefined || k === "User-Agent") headers[k] = v;
    }
    if (userAgent && !String(userAgent).startsWith("CLI/")) {
      headers["User-Agent"] = workbuddyChatHeaders()["User-Agent"];
    }

    const userId =
      credentials?.providerSpecificData?.userId ||
      credentials?.userId ||
      null;
    if (userId) headers["x-user-id"] = userId;

    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }

    const source = Array.isArray(transformed.messages) ? transformed.messages : [];
    transformed.messages = [{ role: "system", content: "You are CodeBuddy Code." }];
    for (const message of source) {
      if (!message || typeof message !== "object" || ["system", "developer"].includes(message.role)) continue;
      if (message.role === "user" && typeof message.content === "string") {
        transformed.messages.push({ ...message, content: [{ type: "text", text: message.content }] });
      } else {
        transformed.messages.push({ ...message });
      }
    }

    return transformed;
  }
}

export default WorkBuddyExecutor;
