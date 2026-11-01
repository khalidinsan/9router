import { describe, it, expect } from "vitest";
import { createSSEStream } from "../../open-sse/utils/stream.js";

/**
 * The markup arrives in pieces, so a delta routinely ends mid-token
 * (`<|tool`, `▁call▁begin|>`). Recovery must survive the fragmentation, and a
 * fragment that never completes must reach the client as the model wrote it —
 * it is prose, not a call.
 */

const CONTENT = `<|tool▁calls▁begin|><|tool▁call▁begin|>bash<|tool▁sep|>{"command":"git remote -v && echo '---STATUS---' && git status -sb && echo '---HEAD---' && git log --oneline -1"}<|tool▁call▁end|><|tool▁calls▁end|>`;

const DSML = `<｜DSML｜ calls>
<｜DSML｜ invoke name="read">
<｜DSML｜ parameter name="path">a.js</｜DSML｜ parameter>
</｜DSML｜ invoke>
</｜DSML｜ calls>`;

const DECLARED_TOOLS = ["read", "bash"].map((name) => ({
  type: "function",
  function: { name, parameters: { type: "object" } },
}));

function buildSSE(slices) {
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({
    id: "x", object: "chat.completion.chunk", created: 1,
    model: "deepseek-v4.1-flash:free",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
  let sse = "";
  for (const s of slices) sse += chunk({ role: "assistant", content: s });
  sse += chunk({}, "stop");
  sse += "data: [DONE]\n\n";
  return sse;
}

async function run(sse) {
  const stream = createSSEStream({
    mode: "passthrough", provider: "tokenharbor",
    model: "deepseek-v4.1-flash:free",
    body: { messages: [], tools: DECLARED_TOOLS },
  });
  const w = stream.writable.getWriter();
  const r = stream.readable.getReader();
  const pump = (async () => {
    const d = new TextDecoder();
    let out = "";
    for (;;) { const { done, value } = await r.read(); if (done) break; out += d.decode(value, { stream: true }); }
    return out;
  })();
  await w.write(new TextEncoder().encode(sse));
  await w.close();
  return pump;
}

function parseChunks(text) {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
    .filter(Boolean);
}

function streamedText(chunks) {
  return chunks.map((c) => c.choices?.[0]?.delta?.content || "").join("");
}

describe("fragmented native markup across SSE deltas", () => {
  it("whole content in one delta", async () => {
    const chunks = parseChunks(await run(buildSSE([CONTENT])));
    const calls = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls || []);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("bash");
    expect(streamedText(chunks)).toBe("");
  });

  it("content split across 2 deltas", async () => {
    const chunks = parseChunks(await run(buildSSE([CONTENT.slice(0, 60), CONTENT.slice(60)])));
    expect(chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls || [])).toHaveLength(1);
    expect(streamedText(chunks)).toBe("");
  });

  it("content split into many 25-char deltas", async () => {
    const slices = [];
    for (let i = 0; i < CONTENT.length; i += 25) slices.push(CONTENT.slice(i, i + 25));
    const chunks = parseChunks(await run(buildSSE(slices)));
    const calls = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls || []);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].function.arguments)).toEqual({
      command: "git remote -v && echo '---STATUS---' && git status -sb && echo '---HEAD---' && git log --oneline -1",
    });
    expect(streamedText(chunks)).toBe("");
  });

  it("marker split mid-token at the worst boundary", async () => {
    const idx = CONTENT.indexOf("<|tool\u2581call\u2581begin|>");
    const cuts = [
      [CONTENT.slice(0, idx + 6), CONTENT.slice(idx + 6)],
      [CONTENT.slice(0, idx + 12), CONTENT.slice(idx + 12)],
      [CONTENT.slice(0, idx + 20), CONTENT.slice(idx + 20)],
    ];
    for (const c of cuts) {
      const chunks = parseChunks(await run(buildSSE(c)));
      expect(chunks.flatMap((x) => x.choices?.[0]?.delta?.tool_calls || [])).toHaveLength(1);
      expect(streamedText(chunks)).toBe("");
    }
  });

  it("DSML split into small deltas still parses", async () => {
    const slices = [];
    for (let i = 0; i < DSML.length; i += 9) slices.push(DSML.slice(i, i + 9));
    const chunks = parseChunks(await run(buildSSE(slices)));
    const calls = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls || []);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("read");
    expect(streamedText(chunks)).toBe("");
  });

  it("a fragment that never completes is forwarded verbatim", async () => {
    // The stream died mid-marker. Nothing is invented, and nothing is silently
    // dropped: the client sees exactly what the model emitted.
    const truncated = DSML.slice(0, DSML.length - 30);
    const chunks = parseChunks(await run(buildSSE([truncated.slice(0, 40), truncated.slice(40)])));
    expect(chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls || [])).toHaveLength(0);
    expect(streamedText(chunks)).toBe(truncated);
  });

  it("a bare fence with the leading angle bracket consumed stays text", async () => {
    const bare = DSML.replaceAll("<｜", "｜");
    const chunks = parseChunks(await run(buildSSE([bare])));
    expect(chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls || [])).toHaveLength(0);
    expect(streamedText(chunks)).toBe(bare);
  });

  it("markup after leading prose streams as text, in order", async () => {
    const content = `Oke bang, aku mulai dari recon dulu.\n\n${CONTENT}`;
    const chunks = parseChunks(await run(buildSSE([content.slice(0, 50), content.slice(50)])));
    expect(chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls || [])).toHaveLength(0);
    expect(streamedText(chunks)).toBe(content);
  });
});
