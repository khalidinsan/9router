// Regression: Antigravity requests must NOT carry a top-level `systemInstruction`.
//
// Upstream rejects it with HTTP 429 RESOURCE_EXHAUSTED (no details, ~100-500ms).
// Measured on one pinned account, interleaved, 10 rounds each:
//   with systemInstruction -> 0/10 successes
//   folded into first user turn -> 10/10
//   dropped entirely -> 10/10
// The trigger is the FIELD, not its size: a 4KB slice fails identically and a
// 79KB prompt succeeds once folded. The official agy CLI never sends it.
import { describe, it, expect } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

const SYSTEM_TEXT = "You are a coding agent.\nFollow the conventions.";

function baseBody() {
  return {
    model: "gemini-3.8-flash-high",
    request: {
      contents: [{ role: "user", parts: [{ text: "Reply with exactly: OK" }] }],
      systemInstruction: { role: "user", parts: [{ text: SYSTEM_TEXT }] },
      generationConfig: { maxOutputTokens: 1024 },
      sessionId: "-1149333584199899460",
    },
  };
}

describe("antigravity executor — systemInstruction handling", () => {
  const executor = new AntigravityExecutor();
  const creds = { projectId: "aicode-consumers", connectionId: "test-conn" };

  it("never emits a top-level systemInstruction", () => {
    const out = executor.transformRequest("gemini-3.8-flash-high", baseBody(), true, creds);
    expect(out.request.systemInstruction).toBeUndefined();
  });

  it("folds the system text into the first user turn, ahead of its parts", () => {
    const out = executor.transformRequest("gemini-3.8-flash-high", baseBody(), true, creds);
    const first = out.request.contents[0];
    expect(first.role).toBe("user");
    expect(first.parts[0].text).toBe(SYSTEM_TEXT);
    expect(first.parts[1].text).toBe("Reply with exactly: OK");
  });

  it("leaves later turns untouched", () => {
    const body = baseBody();
    body.request.contents.push({ role: "model", parts: [{ text: "hi" }] });
    body.request.contents.push({ role: "user", parts: [{ text: "again" }] });
    const out = executor.transformRequest("gemini-3.8-flash-high", body, true, creds);
    expect(out.request.contents).toHaveLength(3);
    expect(out.request.contents[1].parts[0].text).toBe("hi");
    expect(out.request.contents[2].parts[0].text).toBe("again");
  });

  it("creates a user turn when there are no contents at all", () => {
    const body = baseBody();
    body.request.contents = [];
    const out = executor.transformRequest("gemini-3.8-flash-high", body, true, creds);
    expect(out.request.systemInstruction).toBeUndefined();
    expect(out.request.contents[0].parts[0].text).toBe(SYSTEM_TEXT);
  });

  it("is a no-op when there is no systemInstruction", () => {
    const body = baseBody();
    delete body.request.systemInstruction;
    const out = executor.transformRequest("gemini-3.8-flash-high", body, true, creds);
    expect(out.request.systemInstruction).toBeUndefined();
    expect(out.request.contents[0].parts).toHaveLength(1);
  });
});
