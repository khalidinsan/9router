// Guards D3: antigravity 429/503 retry merged into base via computeRetryDelay hook.
// Fork keeps short retry caps + daily CLI fingerprint (not upstream IDE Desktop).
import { describe, it, expect } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import antigravity from "../../open-sse/providers/registry/antigravity.js";
import { platform, arch } from "os";

const MAX_RETRY_AFTER_MS = 5000;
const TRANSIENT_MAX_MS = 3000;
const FORK_UA = `antigravity/cli/1.1.22 (aidev_client; os_type=${platform()}; arch=${arch()}; cl=971564011; auth_method=consumer)`;

function res(status, headers = {}, body = null) {
  return {
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    clone: () => ({ text: async () => (body == null ? "" : JSON.stringify(body)) }),
  };
}

describe("antigravity computeRetryDelay hook (D3)", () => {
  const ag = new AntigravityExecutor();

  it("uses Retry-After header (seconds → ms) when within cap", async () => {
    expect(await ag.computeRetryDelay(res(429, { "retry-after": "5" }), 1)).toBe(5000);
  });

  it("vetoes (false) when Retry-After exceeds cap", async () => {
    expect(await ag.computeRetryDelay(res(429, { "retry-after": "60" }), 1)).toBe(false);
  });

  it("parses retry time from error body when no header", async () => {
    const r = res(429, {}, { error: { message: "quota will reset after 3s" } });
    expect(await ag.computeRetryDelay(r, 1)).toBe(3000);
  });

  it("exponential backoff for 429 when no retry info", async () => {
    expect(await ag.computeRetryDelay(res(429), 1)).toBe(Math.min(1000 * 2 ** 1, MAX_RETRY_AFTER_MS));
    expect(await ag.computeRetryDelay(res(429), 3)).toBe(Math.min(1000 * 2 ** 3, MAX_RETRY_AFTER_MS));
  });

  it("503 without retry info → transient backoff", async () => {
    expect(await ag.computeRetryDelay(res(503), 1)).toBe(Math.min(2000, TRANSIENT_MAX_MS));
  });

  it("retries Antigravity agent terminated body even when status is not 429", async () => {
    const r = res(500, {}, { error: { message: "Agent execution terminated due to error" } });
    expect(await ag.computeRetryDelay(r, 1)).toBe(Math.min(2000, TRANSIENT_MAX_MS));
  });

  it("retries high traffic body", async () => {
    const r = res(500, {}, { error: { message: "Our servers are experiencing high traffic" } });
    expect(await ag.computeRetryDelay(r, 2)).toBe(Math.min(4000, TRANSIENT_MAX_MS));
  });

  it("does not retry non-transient 400 errors", async () => {
    const r = res(400, {}, { error: { message: "Invalid request" } });
    expect(await ag.computeRetryDelay(r, 1)).toBe(false);
  });

  it("deduplicates sanitized tool names", () => {
    const out = ag.transformRequest("claude-opus-4-6-thinking", {
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [{ functionDeclarations: [
          { name: "read/file", parameters: { type: "object", properties: {} } },
          { name: "read file", parameters: { type: "object", properties: {} } },
          { name: "read/file", parameters: { type: "object", properties: {} } },
        ] }],
      },
    }, true, { projectId: "project-1", connectionId: "conn-1" });

    expect(out.request.tools[0].functionDeclarations.map(fn => fn.name)).toEqual(["read_file"]);
  });

  it("registry uses daily cloudcode host, forceStream, and fork CLI user agent", () => {
    expect(antigravity.transport.baseUrls).toEqual(["https://daily-cloudcode-pa.googleapis.com"]);
    expect(antigravity.transport.forceStream).toBe(true);
    expect(antigravity.transport.headers["User-Agent"]).toBe(FORK_UA);
  });

  it("buildHeaders includes session id, local source, and Accept", () => {
    ag._lastSessionId = "sess-123";
    const h = ag.buildHeaders({ accessToken: "tok" }, true);
    expect(h["User-Agent"]).toBe(FORK_UA);
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["Authorization"]).toBe("Bearer tok");
    expect(h["X-Machine-Session-Id"]).toBe("sess-123");
    expect(h["x-request-source"]).toBe("local");
    expect(h["Accept"]).toBe("text/event-stream");
  });

  it("strips rejected top-level thinking fields and falls back to consumer project for accounts without projectId", () => {
    const out = ag.transformRequest("claude-opus-4-6-thinking", {
      project: "generated-project-that-must-not-be-sent",
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      reasoning_effort: "none",
      reasoning: { effort: "none" },
      enable_thinking: false,
      thinking_budget: 0,
      thinkingConfig: { thinkingBudget: 0 },
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        thinking: { type: "disabled" },
      },
    }, true, { connectionId: "consumer-conn" });

    // Consumer accounts without a real projectId fall back to Google's fixed
    // consumer project (official agy CLI behavior) — the generated one is dropped.
    expect(out.project).toBe("aicode-consumers");
    expect(out).not.toHaveProperty("thinking");
    expect(out).not.toHaveProperty("output_config");
    expect(out).not.toHaveProperty("reasoning_effort");
    expect(out).not.toHaveProperty("reasoning");
    expect(out).not.toHaveProperty("enable_thinking");
    expect(out).not.toHaveProperty("thinking_budget");
    expect(out).not.toHaveProperty("thinkingConfig");
    expect(out.request).not.toHaveProperty("thinking");
  });

  it("transforms chat requests with fork requestId shape and 64000 token cap", () => {
    const out = ag.transformRequest("claude-opus-4-6-thinking", {
      request: {
        contents: [
          { role: "user", parts: [{ text: "hi" }] },
          { role: "model", parts: [{ text: "hello" }] },
        ],
        generationConfig: { maxOutputTokens: 90000 },
        sessionId: "-3750763034362895579",
      },
    }, true, { projectId: "project-1", connectionId: "conn-1" });

    expect(out.requestId).toMatch(/^agent-[0-9a-f-]{36}$/);
    expect(out.request.generationConfig.maxOutputTokens).toBe(64000);
  });

  it("drops messages whose parts were stripped to empty (thinking-only assistant history)", () => {
    const out = ag.transformRequest("gemini-3.7-flash-high", {
      request: {
        contents: [
          { role: "user", parts: [{ text: "hi" }] },
          // Thinking-only assistant message: both parts get stripped → must be dropped
          {
            role: "model",
            parts: [
              { thought: true, text: "let me think..." },
              { thoughtSignature: "sig", text: "" },
            ],
          },
          { role: "user", parts: [{ text: "continue" }] },
          {
            role: "model",
            parts: [
              { thought: true, text: "calling tool..." },
              { functionCall: { id: "c1", name: "tool_1", args: {} } },
            ],
          },
          { role: "user", parts: [{ functionResponse: { name: "tool_1", response: { ok: true } } }] },
          { role: "model", parts: [{ text: "done" }] },
        ],
        generationConfig: {},
      },
    }, true, { projectId: null, connectionId: "conn-1" });

    // The thinking-only model message is dropped; functionCall keeps its backfilled signature
    expect(out.request.contents.map(c => c.role)).toEqual(["user", "user", "model", "user", "model"]);
    expect(out.request.contents[2].parts[0]).toMatchObject({
      functionCall: { id: "c1", name: "tool_1", args: {} },
    });
    expect(out.request.contents[2].parts[0].thoughtSignature).toBeTruthy();
    // No message may carry an empty parts array
    for (const c of out.request.contents) {
      expect(c.parts.length).toBeGreaterThan(0);
    }
  });
});
