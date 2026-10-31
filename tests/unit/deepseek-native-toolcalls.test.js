import { describe, it, expect } from "vitest";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { parseSSEToOpenAIResponse } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";

/**
 * DeepSeek V4.1 Flash leaks its native tool-call markup into `content` instead
 * of populating `tool_calls`, so the client prints the raw markup and never
 * runs the tool. Two dialects ship from the same model family:
 *
 *  - DSML, fenced with U+FF5C; one pipe per side via Token Harbor, two via
 *    WorkBuddy.
 *  - raw token-bar, fenced with `<|tool▁…|>`.
 *
 * These samples are verbatim captures from production (9router
 * requestDetails.providerResponse), not hand-written approximations.
 */

const DSML_SINGLE = `<｜DSML｜ calls>
<｜DSML｜ invoke name="read">
<｜DSML｜ parameter name="path" string="true">package.json:1-30</｜DSML｜ parameter>
<｜DSML｜ parameter name="i" string="true">Reading package manifest</｜DSML｜ parameter>
</｜DSML｜ invoke>
</｜DSML｜ calls>`;

const DSML_DOUBLE = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="bash">
<｜｜DSML｜｜ parameter name="command" string="true">ls -la</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;

const TOKEN_BAR = `<|tool▁calls▁begin|><|tool▁call▁begin|>read<|tool▁sep|>{"path":"package.json","i":"Reading"}|tool▁call▁end|><|tool▁calls▁end|>`;

/** Build the upstream SSE that carries `content` as a single delta + a stop chunk. */
function upstreamSSE(content, model = "deepseek-v4.1-flash:free") {
  const chunk = (delta, finish = null) => ({
    id: "chatcmpl-up",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return [
    `data: ${JSON.stringify(chunk({ role: "assistant", content }))}`,
    `data: ${JSON.stringify(chunk({}, "stop"))}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
}

/** Run the real transform stream over `sse` and return the client-visible text. */
async function runStream(sse, { mode = "passthrough", targetFormat = "openai", sourceFormat = "openai", model = "deepseek-v4.1-flash:free" } = {}) {
  const stream = createSSEStream({
    mode,
    targetFormat,
    sourceFormat,
    provider: "tokenharbor",
    model,
    body: { messages: [], tools: [] },
  });
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const pump = (async () => {
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    return out;
  })();
  await writer.write(new TextEncoder().encode(sse));
  await writer.close();
  return pump;
}

/** Parse SSE text into the list of JSON chunks. */
function parseChunks(text) {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
    .filter(Boolean);
}

describe("native DeepSeek tool-call markup recovery", () => {
  it("converts DSML with a single-pipe fence (Token Harbor) into tool_calls", async () => {
    const out = await runStream(upstreamSSE(DSML_SINGLE));
    const chunks = parseChunks(out);
    const withTools = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(withTools).toBeDefined();
    const call = withTools.choices[0].delta.tool_calls[0];
    expect(call.function.name).toBe("read");
    expect(JSON.parse(call.function.arguments)).toEqual({ path: "package.json:1-30", i: "Reading package manifest" });
    expect(out).not.toMatch(/DSML/);
  });

  it("converts DSML with a double-pipe fence (WorkBuddy) into tool_calls", async () => {
    const out = await runStream(upstreamSSE(DSML_DOUBLE), { model: "deepseek-v4.1-flash" });
    const chunks = parseChunks(out);
    const withTools = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(withTools).toBeDefined();
    expect(withTools.choices[0].delta.tool_calls[0].function.name).toBe("bash");
    expect(JSON.parse(withTools.choices[0].delta.tool_calls[0].function.arguments)).toEqual({ command: "ls -la" });
    expect(out).not.toMatch(/DSML/);
  });

  it("converts raw token-bar markup into tool_calls", async () => {
    const out = await runStream(upstreamSSE(TOKEN_BAR));
    const chunks = parseChunks(out);
    const withTools = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(withTools).toBeDefined();
    expect(withTools.choices[0].delta.tool_calls[0].function.name).toBe("read");
    expect(out).not.toMatch(/tool\u2581/);
  });

  it("preserves leading prose and drops the markup", async () => {
    const out = await runStream(upstreamSSE(`Oke, aku cek dulu.\n${DSML_SINGLE}`));
    const chunks = parseChunks(out);
    const text = chunks.map((c) => c.choices?.[0]?.delta?.content || "").join("");
    expect(text).toBe("Oke, aku cek dulu.");
    expect(chunks.some((c) => c.choices?.[0]?.delta?.tool_calls)).toBe(true);
  });

  it("leaves ordinary content untouched", async () => {
    const out = await runStream(upstreamSSE("Just a normal reply."));
    expect(out).toContain("Just a normal reply.");
    expect(out).not.toContain("tool_calls");
  });

  it("does not touch markup for models outside the DeepSeek/Kimi/Claude families", async () => {
    // Claude ids now carry the XML `<invoke>` parser, so this guard needs a
    // family that has no native-markup parser at all.
    const out = await runStream(upstreamSSE(DSML_SINGLE, "gemini-3.8-flash"), { model: "gemini-3.8-flash" });
    expect(out).toMatch(/DSML/);
    expect(out).not.toContain("tool_calls");
  });

  it("recovers markup when a forced-stream provider serves a non-stream client", () => {
    // WorkBuddy is forceStream, so a `stream:false` request is buffered through
    // parseSSEToOpenAIResponse. Without recovery the client gets the raw markup.
    const body = parseSSEToOpenAIResponse(upstreamSSE(DSML_SINGLE), "deepseek-v4.1-flash");
    const msg = body.choices[0].message;
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(msg.content).toBeNull();
    expect(msg.tool_calls[0].function.name).toBe("read");
    expect(JSON.parse(msg.tool_calls[0].function.arguments)).toEqual({
      path: "package.json:1-30",
      i: "Reading package manifest",
    });
  });

  it("leaves a normal forced-stream response alone", () => {
    const body = parseSSEToOpenAIResponse(upstreamSSE("Hello there."), "deepseek-v4.1-flash");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.choices[0].message.content).toBe("Hello there.");
    expect(body.choices[0].message.tool_calls).toBeUndefined();
  });
});

/**
 * A marker the model never finishes is still markup. Production capture from
 * `cmc/deepseek/deepseek-v4.1-flash`: the answer ended mid-token and the client
 * rendered `</|DSML| in`. The holdback must cover every lane that can carry it —
 * the translate lane (commandcode → openai) and the thinking channel both did
 * not, because the guard only ever looked at `delta.content` in passthrough.
 */
describe("unterminated DSML never reaches the client", () => {
  const TRUNCATED = "Let me fix the e2e spec.\n\n</|DSML| in";

  /** Upstream SSE carrying one delta on the given channel. */
  function channelSSE(field, text, model = "deepseek/deepseek-v4.1-flash") {
    const chunk = (delta, finish = null) => ({
      id: "chatcmpl-up",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    return [
      `data: ${JSON.stringify(chunk({ role: "assistant", [field]: text }))}`,
      `data: ${JSON.stringify(chunk({}, "stop"))}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
  }

  const translateOptions = {
    mode: "translate",
    sourceFormat: "commandcode",
    provider: "commandcode",
    model: "deepseek/deepseek-v4.1-flash",
  };

  it("holds it in the translate lane (content)", async () => {
    const out = await runStream(channelSSE("content", TRUNCATED), translateOptions);
    expect(out).not.toMatch(/DSML/);
    expect(out).not.toContain("|DSML|");
    const text = parseChunks(out).map((c) => c.choices?.[0]?.delta?.content || "").join("");
    expect(text).toBe("Let me fix the e2e spec.\n\n");
  });

  it("holds it in the translate lane (reasoning_content)", async () => {
    const out = await runStream(channelSSE("reasoning_content", TRUNCATED), translateOptions);
    expect(out).not.toMatch(/DSML/);
    const text = parseChunks(out).map((c) => c.choices?.[0]?.delta?.reasoning_content || "").join("");
    expect(text).toBe("Let me fix the e2e spec.\n\n");
  });

  it("holds it in the passthrough lane (reasoning_content)", async () => {
    const out = await runStream(channelSSE("reasoning_content", TRUNCATED), {
      model: "deepseek/deepseek-v4.1-flash",
    });
    expect(out).not.toMatch(/DSML/);
  });

  it("still streams a complete call that lands on the thinking channel", async () => {
    // Whole marker inside one delta: dropped, never printed as prose.
    const out = await runStream(channelSSE("reasoning_content", `${DSML_SINGLE}`), translateOptions);
    expect(out).not.toMatch(/DSML/);
  });

  it("keeps a literal trailing `</` that is not a marker", async () => {
    // A delta that ends in markup-looking text but the stream simply stops:
    // the model meant `<em>`, the answer ends, nothing is lost silently.
    const out = await runStream(channelSSE("content", "close the tag </em>"), translateOptions);
    const text = parseChunks(out).map((c) => c.choices?.[0]?.delta?.content || "").join("");
    expect(text).toBe("close the tag </em>");
  });
});
