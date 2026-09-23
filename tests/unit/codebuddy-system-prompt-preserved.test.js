// Regression: codebuddy-intl and workbuddy must NOT discard the client's
// system prompt.
//
// Both gateways require a leading system message (11101 / 11128), but the old
// normalization replaced the whole messages array with `"You are CodeBuddy
// Code."` and skipped every incoming system/developer message. For a coding
// agent the system prompt carries its identity and its tool catalog, so the
// model silently ran without knowing its own tools (e.g. its MCP servers).
import { describe, it, expect, afterEach } from "vitest";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";
import { WorkBuddyExecutor } from "../../open-sse/executors/workbuddy.js";
import {
  buildCodebuddyMessages,
  CODEBUDDY_SYSTEM_MARKER,
} from "../../open-sse/shared/codebuddyMessages.js";

const AGENT_PROMPT = "You are omp, a coding agent. Use mcp://playwright_browser_navigate to drive a browser.";

const executors = [
  ["CodeBuddyIntlExecutor", new CodeBuddyIntlExecutor()],
  ["WorkBuddyExecutor", new WorkBuddyExecutor()],
];

describe.each(executors)("%s preserves the client system prompt", (_name, exec) => {
  it("keeps the leading system message the gateway requires", () => {
    const out = exec.transformRequest("glm-5.2", { messages: [{ role: "user", content: "hi" }] }, false, {});
    expect(out.messages[0].role).toBe("system");
    expect(out.messages[0].content).toContain(CODEBUDDY_SYSTEM_MARKER);
  });

  it("makes the client's system prompt the leading message, without a false identity prefix", () => {
    const out = exec.transformRequest(
      "glm-5.2",
      {
        messages: [
          { role: "system", content: AGENT_PROMPT },
          { role: "user", content: "run playwright" },
        ],
      },
      false,
      {}
    );

    const system = out.messages[0];
    expect(system.role).toBe("system");
    expect(system.content).toContain("You are omp");
    expect(system.content).toContain("mcp://playwright_browser_navigate");
    // The client's own prompt is the identity; the generic marker must not
    // sit in front of it or the model adopts it.
    expect(system.content).not.toContain(CODEBUDDY_SYSTEM_MARKER);
  });

  it("preserves multiple system messages in order", () => {
    const out = exec.transformRequest(
      "glm-5.2",
      {
        messages: [
          { role: "system", content: "FIRST_BLOCK" },
          { role: "system", content: "SECOND_BLOCK" },
          { role: "user", content: "go" },
        ],
      },
      false,
      {}
    );

    const system = out.messages[0];
    expect(system.content).toContain("FIRST_BLOCK");
    expect(system.content).toContain("SECOND_BLOCK");
    expect(system.content.indexOf("FIRST_BLOCK")).toBeLessThan(system.content.indexOf("SECOND_BLOCK"));
  });

  it("flattens typed-block system content", () => {
    const out = exec.transformRequest(
      "glm-5.2",
      {
        messages: [
          { role: "system", content: [{ type: "text", text: "BLOCK_TEXT_MARKER" }] },
          { role: "user", content: "go" },
        ],
      },
      false,
      {}
    );
    expect(out.messages[0].content).toContain("BLOCK_TEXT_MARKER");
  });

  it("keeps user content as typed blocks and preserves the conversation", () => {
    const out = exec.transformRequest(
      "glm-5.2",
      {
        messages: [
          { role: "system", content: "S" },
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi there" },
          { role: "user", content: "bye" },
        ],
      },
      false,
      {}
    );

    const [, ...rest] = out.messages;
    expect(rest).toHaveLength(3);
    expect(rest[0]).toEqual({ role: "user", content: [{ type: "text", text: "hello" }] });
    expect(rest[1]).toEqual({ role: "assistant", content: "hi there" });
    expect(rest[2]).toEqual({ role: "user", content: [{ type: "text", text: "bye" }] });
  });

  it("still emits exactly one leading system message", () => {
    const out = exec.transformRequest(
      "glm-5.2",
      { messages: [{ role: "system", content: "S" }, { role: "user", content: "u" }] },
      false,
      {}
    );
    expect(out.messages.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("forces stream", () => {
    const out = exec.transformRequest("glm-5.2", { messages: [{ role: "user", content: "u" }] }, false, {});
    expect(out.stream).toBe(true);
  });

  it("still mirrors reasoning_summary when reasoning was requested", () => {
    const out = exec.transformRequest(
      "glm-5.2",
      { messages: [{ role: "user", content: "u" }], reasoning_effort: "high" },
      false,
      {}
    );
    expect(out.reasoning_effort).toBe("high");
    expect(out.reasoning_summary).toBe("auto");
  });
});

describe("buildCodebuddyMessages", () => {
  afterEach(() => {
    delete process.env.CODEBUDDY_NEUTRALIZE_SYSTEM;
  });

  it("tolerates a missing messages array", () => {
    expect(buildCodebuddyMessages(undefined)).toEqual([
      { role: "system", content: CODEBUDDY_SYSTEM_MARKER },
    ]);
  });

  it("skips malformed entries without throwing", () => {
    const out = buildCodebuddyMessages([null, "nope", { role: "user", content: "ok" }]);
    expect(out).toHaveLength(2);
    expect(out[1].role).toBe("user");
  });

  it("drops empty system messages and falls back to the marker when none remain", () => {
    const out = buildCodebuddyMessages([{ role: "system", content: "   " }, { role: "user", content: "u" }]);
    expect(out[0].content).toBe(CODEBUDDY_SYSTEM_MARKER);
  });

  it("opt-in escape hatch restores neutralization for a rejecting gateway", () => {
    process.env.CODEBUDDY_NEUTRALIZE_SYSTEM = "1";
    const out = buildCodebuddyMessages([{ role: "system", content: AGENT_PROMPT }, { role: "user", content: "u" }]);
    expect(out[0].content).toBe(CODEBUDDY_SYSTEM_MARKER);
    expect(out[0].content).not.toContain("mcp://");
  });
});
