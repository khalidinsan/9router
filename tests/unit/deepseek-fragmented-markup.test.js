import { describe, it, expect } from "vitest";
import { createSSEStream } from "../../open-sse/utils/stream.js";

const CONTENT = `Oke bang, aku mulai dari recon dulu (read-only, belum ada yang berubah).

<|tool▁calls▁begin|><|tool▁call▁begin|>bash<|tool▁sep|>{"command":"git remote -v && echo '---STATUS---' && git status -sb && echo '---HEAD---' && git log --oneline -1"}<|tool▁call▁end|><|tool▁calls▁end|>`;

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
    model: "deepseek-v4.1-flash:free", body: { messages: [] },
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

describe("fragmented native markup across SSE deltas", () => {
  it("whole content in one delta", async () => {
    const out = await run(buildSSE([CONTENT]));
    expect(out).toContain('"tool_calls"');
    expect(out).not.toMatch(/tool\u2581/);
  });

  it("content split across 2 deltas", async () => {
    const out = await run(buildSSE([CONTENT.slice(0, 60), CONTENT.slice(60)]));
    expect(out).toContain('"tool_calls"');
    expect(out).not.toMatch(/tool\u2581/);
  });

  it("content split into many 25-char deltas", async () => {
    const slices = [];
    for (let i = 0; i < CONTENT.length; i += 25) slices.push(CONTENT.slice(i, i + 25));
    const out = await run(buildSSE(slices));
    expect(out).toContain('"tool_calls"');
    expect(out).not.toMatch(/tool\u2581/);
  });

  it("marker split mid-token at the worst boundary", async () => {
    // Split inside `<|tool▁call▁begin|>` so the detector sees a partial marker.
    const idx = CONTENT.indexOf("<|tool\u2581call\u2581begin|>");
    const cuts = [
      [CONTENT.slice(0, idx + 6), CONTENT.slice(idx + 6)],
      [CONTENT.slice(0, idx + 12), CONTENT.slice(idx + 12)],
      [CONTENT.slice(0, idx + 20), CONTENT.slice(idx + 20)],
    ];
    for (const c of cuts) {
      const out = await run(buildSSE(c));
      expect(out).toContain('"tool_calls"');
      expect(out).not.toMatch(/tool\u2581/);
    }
  });

  it("DSML wrapper header is held, not leaked as prose", async () => {
    // Production leak: the wrapper line reached the client while the invoke
    // that followed was still streaming.
    const dsml = `<｜DSML｜ calls>\n<｜DSML｜ invoke name="read">\n<｜DSML｜ parameter name="path">a.js</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>`;
    const slices = [];
    for (let i = 0; i < dsml.length; i += 9) slices.push(dsml.slice(i, i + 9));
    const out = await run(buildSSE(slices));
    expect(out).toContain('"tool_calls"');
    expect(out).not.toMatch(/DSML/);
  });

  it("fence with the leading angle bracket already consumed still parses", async () => {
    // Production leak: upstream emitted `|DSML| calls>` with no `<`.
    const bare = `｜DSML｜ calls>\n｜DSML｜ invoke name="read">\n｜DSML｜ parameter name="path">a.js</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>`;
    const out = await run(buildSSE([bare]));
    expect(out).toContain('"tool_calls"');
    expect(out).not.toMatch(/DSML/);
  });

  it("truncated markup is dropped, never forwarded as text", async () => {
    // A stream that dies mid-marker: the held fragment is markup, so it must
    // not reach the client as prose.
    const out = await run(buildSSE([`｜DSML｜ calls>`]));
    expect(out).not.toMatch(/DSML/);
  });
});
