import { DefaultExecutor } from "./default.js";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import {
  workbuddyChatHeaders,
  workbuddyConversationHeaders,
} from "../config/workbuddy.js";
import { buildCodebuddyMessages } from "../shared/codebuddyMessages.js";
import { firstUserMessageSessionId } from "../utils/sessionManager.js";
import { v4 as uuidv4, v7 as uuidv7 } from "uuid";

/**
 * WorkBuddyExecutor — talks to https://www.workbuddy.ai/v2/chat/completions
 *
 * Same stream-only OpenAI-compatible gateway as CodeBuddy, plus behaviours
 * read out of the bundled CLI (2.161.0) that WorkBuddy AI 5.8.4 ships:
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
 *  - The CLI's `axiosToFetchAdapter` stamps those headers on every model call
 *    (`M[CONVERSATION_ID_HEADER] = session.id` etc.), which is the exact set we
 *    mirror: X-Conversation-ID (UUIDv4 session id), X-Conversation-Request-ID
 *    (bare-hex UUIDv7), X-Conversation-Message-ID = X-Request-ID (bare-hex
 *    UUIDv7), X-Root-Request-ID (= the conversation request id), X-Agent-Intent
 *    "craft", X-Agent-Type "main", X-Agent-Purpose "conversation".
 *  - x-user-id carries the account sub; the gateway scopes billing to it.
 */
export class WorkBuddyExecutor extends DefaultExecutor {
  constructor() {
    super("workbuddy");
  }

  buildHeaders(credentials, stream = true, url, model, body = null) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    for (const [k, v] of Object.entries(workbuddyChatHeaders())) {
      if (headers[k] === undefined || k === "User-Agent") headers[k] = v;
    }

    const userId =
      credentials?.providerSpecificData?.userId ||
      credentials?.userId ||
      null;
    if (userId) headers["x-user-id"] = userId;

    // Official-client conversation metadata (required by channel verification).
    // Message id is the request identity: X-Conversation-Message-ID and
    // X-Request-ID share one value, exactly as the client sends them.
    // X-Root-Request-ID mirrors the conversation request id (the CLI's
    // resolveRootRequestId falls back to it), so pass it explicitly.
    const messageId = newRequestId();
    const conversationRequestId = newRequestId();
    Object.assign(
      headers,
      workbuddyConversationHeaders({
        conversationId: resolveConversationId(credentials, body),
        conversationRequestId,
        messageId,
        rootRequestId: conversationRequestId,
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
 * Official request/message ids are UUIDv7 with the dashes stripped, e.g.
 * `01a17b38a11e7517bd1a81950cb643fe` (the CLI does
 * `uuidv7().replace(/-/g, "")`; live log lines show `requestId=01a17b38…`).
 * Fresh per call.
 */
function newRequestId() {
  return uuidv7().replace(/-/g, "");
}

// Conversation-stable channel ids: one per (connection, first user message) so
// every turn of a chat reports the same X-Conversation-ID, like the client's
// per-chat session. Keyed on the same anchor grok-cli/opencode use, evicted
// after MEMORY_CONFIG.sessionTtlMs.
//
// The official value is the CLI session id, which is a plain UUIDv4
// (`54338068-013a-4e2f-8cc7-f8d45186c484` — every `*.jsonl` session file under
// ~/.workbuddy-ai/projects is named after one), not the UUIDv7 used for
// per-request ids.
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
  if (!anchor) return uuidv4();

  const existing = conversationStore.get(anchor);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.conversationId;
  }

  const conversationId = uuidv4();
  if (conversationStore.size >= MAX_CONVERSATIONS) {
    conversationStore.delete(conversationStore.keys().next().value);
  }
  conversationStore.set(anchor, { conversationId, lastUsed: Date.now() });
  return conversationId;
}

export default WorkBuddyExecutor;
