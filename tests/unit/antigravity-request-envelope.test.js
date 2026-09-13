// Regression: Antigravity agent requests must NOT carry `requestType: "agent"`.
//
// That flag switches Cloud Code Assist into strict agent-mode inspection, which
// rejects this gateway's prompt with a detail-free HTTP 429 RESOURCE_EXHAUSTED
// in ~100-500ms while the account quota is untouched (97% remaining on every
// account when measured). Verified against the live endpoint, 3 accounts x 5
// interleaved rounds, identical 79KB prompt:
//
//   requestType "agent" + systemInstruction -> 0/15 successes
//   no requestType       + systemInstruction -> 15/15
//   "file_edit" / "conversation" instead     -> 5/5 each
//
// The failure is not content- or size-driven: that same prompt passes verbatim
// without the flag, and a neutral 79KB filler always passes. systemInstruction
// itself is harmless and must be preserved (agy's own CLI sends one).
import { describe, it, expect } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

function baseBody() {
  return {
    model: "gemini-3.8-flash-high",
    request: {
      contents: [{ role: "user", parts: [{ text: "Reply with exactly: OK" }] }],
      systemInstruction: { role: "user", parts: [{ text: "You are a coding agent." }] },
      generationConfig: { maxOutputTokens: 1024 },
      sessionId: "-1149333584199899460",
    },
  };
}

describe("antigravity executor — request envelope", () => {
  const executor = new AntigravityExecutor();
  const creds = { projectId: "aicode-consumers", connectionId: "test-conn" };

  it('does not send requestType "agent"', () => {
    const out = executor.transformRequest("gemini-3.8-flash-high", baseBody(), true, creds);
    expect(out.requestType).not.toBe("agent");
  });

  it("preserves systemInstruction instead of folding it into the user turn", () => {
    const out = executor.transformRequest("gemini-3.8-flash-high", baseBody(), true, creds);
    expect(out.request.systemInstruction.parts[0].text).toBe("You are a coding agent.");
    // the user turn keeps only its own content
    expect(out.request.contents[0].parts).toHaveLength(1);
    expect(out.request.contents[0].parts[0].text).toBe("Reply with exactly: OK");
  });

  it("still emits the IDE-shaped requestId", () => {
    const out = executor.transformRequest("gemini-3.8-flash-high", baseBody(), true, creds);
    expect(out.requestId).toMatch(/^agent\/[^/]+\/\d+\/[^/]+\/\d+$/);
  });
});
