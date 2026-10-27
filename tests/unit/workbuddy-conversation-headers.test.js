// Regression: the WorkBuddy gateway runs a channel verification on model calls
// and answers 400 `{code:11128, msg:"conversation id missing"}` when the
// official client's conversation headers are absent — notably when
// X-Conversation-Request-ID is empty. The official client (WorkBuddy AI 5.8.4,
// CLI 2.161.0) sends the whole set on every call: a UUIDv4 session id plus
// bare-hex UUIDv7 request ids. Without them, flagged accounts cannot chat at
// all; healthy accounts pass but the check can tighten.
import { describe, it, expect } from "vitest";
import { WorkBuddyExecutor } from "../../open-sse/executors/workbuddy.js";
import {
  WORKBUDDY_CONVERSATION_HEADERS,
  workbuddyOAuthHeaders,
} from "../../open-sse/config/workbuddy.js";

const executor = new WorkBuddyExecutor();

const credentials = {
  accessToken: "test-token",
  connectionId: "conn-1",
  providerSpecificData: { userId: "user-1" },
};

const bodyFor = (text) => ({
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: [{ type: "text", text }] },
  ],
});

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX32_RE = /^[0-9a-f]{32}$/;

describe("workbuddy conversation headers", () => {
  const headers = executor.buildHeaders(credentials, true, null, "deepseek-v4.1-flash", bodyFor("hi"));

  it("sends the full official conversation header set", () => {
    const h = WORKBUDDY_CONVERSATION_HEADERS;
    expect(headers[h.conversationId]).toBeTruthy();
    expect(headers[h.conversationRequestId]).toBeTruthy();
    expect(headers[h.conversationMessageId]).toBeTruthy();
    expect(headers[h.requestId]).toBeTruthy();
    expect(headers[h.rootRequestId]).toBe(headers[h.conversationRequestId]);
    expect(headers[h.agentIntent]).toBe("craft");
    expect(headers[h.agentType]).toBe("main");
    expect(headers[h.agentPurpose]).toBe("conversation");
  });

  it("emits a UUIDv4 conversation id and bare-hex request/message ids", () => {
    const h = WORKBUDDY_CONVERSATION_HEADERS;
    // The CLI session id (X-Conversation-ID) is a plain UUIDv4, unlike the
    // bare-hex UUIDv7 used for per-request ids.
    expect(headers[h.conversationId]).toMatch(UUID_V4_RE);
    expect(headers[h.conversationRequestId]).toMatch(HEX32_RE);
    expect(headers[h.conversationMessageId]).toMatch(HEX32_RE);
    expect(headers[h.conversationMessageId]).toBe(headers[h.requestId]);
  });

  it("keeps one conversation id per conversation and refreshes per-request ids", () => {
    const h = WORKBUDDY_CONVERSATION_HEADERS;
    const first = executor.buildHeaders(credentials, true, null, "m", bodyFor("hello world"));
    const second = executor.buildHeaders(credentials, true, null, "m", {
      messages: [
        { role: "user", content: "hello world" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "again" },
      ],
    });
    expect(second[h.conversationId]).toBe(first[h.conversationId]);
    expect(second[h.conversationMessageId]).not.toBe(first[h.conversationMessageId]);
    expect(second[h.conversationRequestId]).not.toBe(first[h.conversationRequestId]);

    const other = executor.buildHeaders(credentials, true, null, "m", bodyFor("different chat"));
    expect(other[h.conversationId]).not.toBe(first[h.conversationId]);

    const otherConn = executor.buildHeaders(
      { ...credentials, connectionId: "conn-2" },
      true,
      null,
      "m",
      bodyFor("hello world")
    );
    expect(otherConn[h.conversationId]).not.toBe(first[h.conversationId]);
  });

  it("still sends a non-empty conversation id without a user message", () => {
    const h = WORKBUDDY_CONVERSATION_HEADERS;
    const headers = executor.buildHeaders(credentials, true, null, "m", { messages: [] });
    expect(headers[h.conversationId]).toMatch(UUID_V4_RE);
    expect(headers[h.conversationRequestId]).toBeTruthy();
  });

  it("does not leak conversation headers into OAuth requests", () => {
    const oauth = workbuddyOAuthHeaders();
    for (const key of Object.values(WORKBUDDY_CONVERSATION_HEADERS)) {
      expect(oauth[key]).toBeUndefined();
    }
  });

  it("presents the WorkBuddy 5.8.4 desktop fingerprint", () => {
    // A desktop-launched CLI sidecar on 5.8.4 reports
    // `WorkBuddy/5.8.4 CLI/2.161.0` (CLIENT_INFO_PLATFORM=WorkBuddy,
    // platformVersion 5.8.4, UA extension CLI/2.161.0).
    expect(headers["User-Agent"]).toBe("WorkBuddy/5.8.4 CLI/2.161.0");
    expect(headers["X-IDE-Type"]).toBe("WorkBuddy");
    expect(headers["X-IDE-Name"]).toBe("WorkBuddy");
    expect(headers["X-IDE-Version"]).toBe("5.8.4");
    expect(headers["X-Product"]).toBe("SaaS");
    expect(headers["X-Domain"]).toBe("www.workbuddy.ai");
  });
});
