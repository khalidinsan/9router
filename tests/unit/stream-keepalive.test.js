import { describe, it, expect } from "vitest";
import { createSSEStream } from "../../open-sse/utils/stream.js";

/**
 * Kiro delivers a tool-call payload as one burst at the end of the generation
 * (119 fragments inside 12 ms, 14 s in), so the connection can sit silent for
 * minutes. SSE comments keep it alive; every other lane streams progressively
 * and must not get them.
 */

function makeStream(provider) {
  return createSSEStream({
    mode: "translate",
    targetFormat: "openai",
    sourceFormat: "openai",
    provider,
    model: "claude-opus-5.5-thinking",
    body: { messages: [], tools: [] },
    keepaliveIntervalMs: 40,
    keepaliveIdleMs: 40,
  });
}

/** Read whatever the stream produces for `ms`, then stop. */
async function collectFor(stream, ms) {
  const reader = stream.readable.getReader();
  const decoder = new TextDecoder();
  let out = "";
  const stop = new Promise((resolve) => setTimeout(resolve, ms));
  let finished = false;
  stop.then(() => { finished = true; reader.cancel().catch(() => {}); });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (finished) break;
    }
  } catch {
    /* cancelled */
  }
  return out;
}

describe("SSE keep-alive", () => {
  it("emits a comment while a Kiro stream is silent", async () => {
    const stream = makeStream("kiro");
    const out = await collectFor(stream, 200);
    expect(out).toContain(": keepalive");
    // A comment only — never fabricated content.
    expect(out).not.toContain("data:");
  });

  it("stays out of every other provider", async () => {
    const stream = makeStream("tokenharbor");
    const out = await collectFor(stream, 200);
    expect(out).not.toContain(": keepalive");
  });

  it("keeps the SSE payload intact around the comments", async () => {
    const stream = makeStream("kiro");
    const writer = stream.writable.getWriter();
    const reading = collectFor(stream, 300);
    await new Promise((r) => setTimeout(r, 90)); // let a keep-alive fire first
    const chunk = {
      id: "c1", object: "chat.completion.chunk", created: 1, model: "claude-opus-5.5-thinking",
      choices: [{ index: 0, delta: { content: "halo" }, finish_reason: null }],
    };
    await writer.write(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
    await writer.close();
    const out = await reading;
    expect(out).toContain(": keepalive");
    expect(out).toContain('"content":"halo"');
    // Comments must be whole lines so the SSE reader skips them.
    for (const line of out.split("\n")) {
      if (line.includes(": keepalive")) expect(line.trim()).toBe(": keepalive");
    }
  });
});
