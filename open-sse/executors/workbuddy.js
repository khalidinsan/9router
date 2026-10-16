import { DefaultExecutor } from "./default.js";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import {
  workbuddyChatHeaders,
  workbuddyConversationHeaders,
} from "../config/workbuddy.js";
import { buildCodebuddyMessages } from "../shared/codebuddyMessages.js";
import { firstUserMessageSessionId } from "../utils/sessionManager.js";
import { v7 as uuidv7 } from "uuid";

/**
 * WorkBuddyExecutor — talks to https://www.workbuddy.ai/v2/chat/completions
 *
 * Same stream-only OpenAI-compatible gateway as CodeBuddy, plus behaviours
 * captured from the bundled CLI's wire traffic:
 *
 *  - The gateway rejects a bare OpenAI shape with 11128 "first message is not
 *    system prompt", so a leading system message is always prepended and user
 *    content is sent as typed blocks. The client's own system prompt is folded
 *    into that leading message — see shared/codebuddyMessages.js.
 *  - Channel verification: model calls without the official conversation
 *    header set (and specifically a non-empty X-Conversation-Request-ID) are
 *    answered 400 11128 "conversation id missing" / "channel verification".
 *    The gateway enforces it per account/risk-tier, so headers present on a
 *    fresh account can start being required later. Send them on every call —
 *    see config/workbuddy.js workbuddyConversationHeaders.
 *  - x-user-id carries the account sub; the gateway scopes billing to it.
 */
export class WorkBuddyExecutor extends DefaultExecutor {
  constructor() {
    super("workbuddy");
  }

  buildHeaders(credentials, stream = true, url, model, body = null) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);
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

    // Official-client conversation metadata (required by channel verification).
    // Message id is the request identity: X-Conversation-Message-ID and
    // X-Request-ID share one value, exactly as the client sends them.
    const messageId = newRequestId();
    Object.assign(
      headers,
      workbuddyConversationHeaders({
        conversationId: resolveConversationId(credentials, body),
        conversationRequestId: newRequestId(),
        messageId,
      })
    );

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

    transformed.messages = buildCodebuddyMessages(transformed.messages);

    return transformed;
  }
}

/**
 * Official ids are UUIDv7 with the dashes stripped, e.g.
 * `01a1422b67e577a4a4a530382d538306`. Fresh per call.
 */
function newRequestId() {
  return uuidv7().replace(/-/g, "");
}

// Conversation-stable channel ids: one per (connection, first user message) so
// every turn of a chat reports the same X-Conversation-ID, like the client's
// per-chat session. Keyed on the same anchor grok-cli/opencode use, evicted
// after MEMORY_CONFIG.sessionTtlMs.
const conversationStore = new Map();
const MAX_CONVERSATIONS = 1000;
const conversationCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of conversationStore) {
    if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) {
      conversationStore.delete(key);
    }
  }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (conversationCleanup.unref) conversationCleanup.unref();

function resolveConversationId(credentials, body) {
  const connectionId = credentials?.connectionId || credentials?.id;
  const anchor = firstUserMessageSessionId("workbuddy", connectionId, body);
  // No conversation anchor (empty/no user message) → one-shot id, never reused.
  if (!anchor) return uuidv7();

  const existing = conversationStore.get(anchor);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.conversationId;
  }

  const conversationId = uuidv7();
  if (conversationStore.size >= MAX_CONVERSATIONS) {
    conversationStore.delete(conversationStore.keys().next().value);
  }
  conversationStore.set(anchor, { conversationId, lastUsed: Date.now() });
  return conversationId;
}

export default WorkBuddyExecutor;
