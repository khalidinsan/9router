import { describe, it, expect } from "vitest";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { parseSSEToOpenAIResponse } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { normalizeDeepseekToolCalls } from "../../open-sse/utils/deepseekToolParser.js";

/**
 * DeepSeek V4.1 Flash intermittently leaks its native tool-call markup into
 * `content` instead of populating `tool_calls`, so the client prints the raw
 * markup and never runs the tool. Two dialects ship from the same family:
 *
 *  - DSML, fenced with U+FF5C; one pipe per side via Token Harbor, two via
 *    WorkBuddy.
 *  - raw token-bar, fenced with `<|tool▁…|>`.
 *
 * Recovery is limited to a *standalone, complete* payload on a request that
 * declared tools. Everything else — prose around the markup, a fenced sample, a
 * truncated capture, a damaged opener — reaches the client as the model wrote
 * it. A model explaining the dialect must not trigger a tool.
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

const DSML_MULTI = `<｜DSML｜ calls>
<｜DSML｜ invoke name="read">
<｜DSML｜ parameter name="path">a.js</｜DSML｜ parameter>
</｜DSML｜ invoke>
<｜DSML｜ invoke name="bash">
<｜DSML｜ parameter name="command">git status --short</｜DSML｜ parameter>
</｜DSML｜ invoke>
</｜DSML｜ calls>`;

const TOKEN_BAR = `<|tool▁calls▁begin|><|tool▁call▁begin|>read<|tool▁sep|>{"path":"package.json","i":"Reading"}<|tool▁call▁end|><|tool▁calls▁end|>`;

const DECLARED_TOOLS = ["read", "bash", "write"].map((name) => ({
  type: "function",
  function: { name, parameters: { type: "object" } },
}));

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
async function runStream(sse, {
  mode = "passthrough",
  targetFormat = "openai",
  sourceFormat = "openai",
  model = "deepseek-v4.1-flash:free",
  tools = DECLARED_TOOLS,
  toolChoice,
} = {}) {
  const body = { messages: [] };
  if (tools) body.tools = tools;
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  const stream = createSSEStream({
    mode,
    targetFormat,
    sourceFormat,
    provider: "tokenharbor",
    model,
    body,
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

function toolCallsOf(chunks) {
  return chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls || []);
}

function streamedText(chunks) {
  return chunks.map((c) => c.choices?.[0]?.delta?.content || "").join("");
}

describe("standalone complete payload becomes tool_calls", () => {
  it("converts DSML with a single-pipe fence (Token Harbor)", async () => {
    const chunks = parseChunks(await runStream(upstreamSSE(DSML_SINGLE)));
    const calls = toolCallsOf(chunks);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("read");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({
      path: "package.json:1-30",
      i: "Reading package manifest",
    });
    expect(streamedText(chunks)).toBe("");
  });

  it("converts DSML with a double-pipe fence (WorkBuddy)", async () => {
    const chunks = parseChunks(await runStream(upstreamSSE(DSML_DOUBLE)));
    const calls = toolCallsOf(chunks);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("bash");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ command: "ls -la" });
  });

  it("converts raw token-bar markup", async () => {
    const chunks = parseChunks(await runStream(upstreamSSE(TOKEN_BAR)));
    const calls = toolCallsOf(chunks);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("read");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: "package.json", i: "Reading" });
  });

  it("emits every distinct call of a multi-call payload, with distinct ids and indices", async () => {
    const chunks = parseChunks(await runStream(upstreamSSE(DSML_MULTI)));
    const calls = toolCallsOf(chunks);
    expect(calls.map((c) => c.function.name)).toEqual(["read", "bash"]);
    expect(new Set(calls.map((c) => c.id)).size).toBe(2);
    expect(calls.map((c) => c.index)).toEqual([0, 1]);
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: "a.js" });
    expect(JSON.parse(calls[1].function.arguments)).toEqual({ command: "git status --short" });
  });

  it("keeps argument strings exact", () => {
    const content = `<｜DSML｜ invoke name="write">
<｜DSML｜ parameter name="path">app/besar.php</｜DSML｜ parameter>
<｜DSML｜ parameter name="content">$x = "a"; if ($x) { echo 'b'; }
</｜DSML｜ parameter>
</｜DSML｜ invoke>`;
    const { message, hasTools } = normalizeDeepseekToolCalls({ role: "assistant", content });
    expect(hasTools).toBe(true);
    expect(JSON.parse(message.tool_calls[0].function.arguments)).toEqual({
      path: "app/besar.php",
      content: `$x = "a"; if ($x) { echo 'b'; }\n`,
    });
  });

  it("recovers a forced-stream provider serving a non-stream client", () => {
    const body = parseSSEToOpenAIResponse(upstreamSSE(DSML_SINGLE), "deepseek-v4.1-flash", {
      messages: [],
      tools: DECLARED_TOOLS,
    });
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
    const body = parseSSEToOpenAIResponse(upstreamSSE("Hello there."), "deepseek-v4.1-flash", {
      messages: [],
      tools: DECLARED_TOOLS,
    });
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.choices[0].message.content).toBe("Hello there.");
    expect(body.choices[0].message.tool_calls).toBeUndefined();
  });
});

describe("request-level gates keep the text verbatim", () => {
  it("keeps markup as text when the request declared no tools", async () => {
    const chunks = parseChunks(await runStream(upstreamSSE(DSML_SINGLE), { tools: null }));
    expect(toolCallsOf(chunks)).toHaveLength(0);
    expect(streamedText(chunks)).toBe(DSML_SINGLE);
  });

  it("keeps markup as text when tool_choice is none", async () => {
    const chunks = parseChunks(await runStream(upstreamSSE(DSML_SINGLE), { toolChoice: "none" }));
    expect(toolCallsOf(chunks)).toHaveLength(0);
    expect(streamedText(chunks)).toBe(DSML_SINGLE);
  });

  it("keeps markup as text for a model with no native-markup parser", async () => {
    const chunks = parseChunks(
      await runStream(upstreamSSE(DSML_SINGLE, "gemini-3.8-flash"), { model: "gemini-3.8-flash" }),
    );
    expect(toolCallsOf(chunks)).toHaveLength(0);
    expect(streamedText(chunks)).toBe(DSML_SINGLE);
  });

  it("never replaces tool calls the message already carries", () => {
    const existing = [{ id: "call_real", type: "function", function: { name: "read", arguments: '{"path":"a.js"}' } }];
    const { message, hasTools } = normalizeDeepseekToolCalls({
      role: "assistant",
      content: DSML_SINGLE,
      tool_calls: existing,
    });
    expect(hasTools).toBe(false);
    expect(message.tool_calls).toEqual(existing);
    expect(message.content).toBe(DSML_SINGLE);
  });
});

/**
 * Only a standalone payload is an action. Prose, a fenced sample, or anything
 * else that frames the markup as an example means the model is talking about
 * the dialect, so the whole message stays literal.
 */
describe("explanatory markup stays literal", () => {
  it("leaves markup behind leading prose as text", async () => {
    const content = `Oke, aku cek dulu.\n${DSML_SINGLE}`;
    const chunks = parseChunks(await runStream(upstreamSSE(content)));
    expect(toolCallsOf(chunks)).toHaveLength(0);
    expect(streamedText(chunks)).toBe(content);
  });

  it("leaves markup followed by an explanation as text", async () => {
    const content = `${DSML_SINGLE}\n\nPanggilan di atas hanya ilustrasi.`;
    const chunks = parseChunks(await runStream(upstreamSSE(content)));
    expect(toolCallsOf(chunks)).toHaveLength(0);
    expect(streamedText(chunks)).toBe(content);
  });

  it("leaves a fenced sample untouched", async () => {
    const content = `Formatnya begini:\n\n\`\`\`\n${DSML_SINGLE}\n\`\`\`\n\nItu contoh saja.`;
    const chunks = parseChunks(await runStream(upstreamSSE(content)));
    expect(toolCallsOf(chunks)).toHaveLength(0);
    expect(streamedText(chunks)).toBe(content);
  });

  it("leaves prose between two invokes untouched", () => {
    const content = `<｜DSML｜ invoke name="read">
<｜DSML｜ parameter name="path">a.js</｜DSML｜ parameter>
</｜DSML｜ invoke>
lalu
<｜DSML｜ invoke name="read">
<｜DSML｜ parameter name="path">b.js</｜DSML｜ parameter>
</｜DSML｜ invoke>`;
    const { message, hasTools } = normalizeDeepseekToolCalls({ role: "assistant", content });
    expect(hasTools).toBe(false);
    expect(message.content).toBe(content);
  });

  it("leaves ordinary content untouched", async () => {
    const out = await runStream(upstreamSSE("Just a normal reply."));
    expect(out).toContain("Just a normal reply.");
    expect(out).not.toContain("tool_calls");
  });
});

/**
 * A damaged or partial payload is prose. Nothing is synthesized: a missing
 * `<`, an unclosed invoke, a missing `calls` close, or a broken JSON body all
 * stay literal instead of becoming a call with guessed arguments.
 */
describe("malformed payloads stay literal", () => {
  const CASES = {
    "truncated payload": DSML_SINGLE.slice(0, DSML_SINGLE.length - 40),
    "missing calls close": DSML_SINGLE.replace("</｜DSML｜ calls>", ""),
    "missing invoke close": DSML_SINGLE.replace("</｜DSML｜ invoke>", ""),
    "fence with the leading angle bracket consumed": DSML_SINGLE.replaceAll("<｜", "｜"),
    "mismatched fence width": `<｜DSML｜ invoke name="read">
<｜DSML｜ parameter name="path">a.js</｜｜DSML｜｜ parameter>
</｜DSML｜ invoke>`,
    "unclosed parameter": `<｜DSML｜ invoke name="write">
<｜DSML｜ parameter name="path">a.md</｜DSML｜ parameter>
<｜DSML｜ parameter name="content">unterminated
</｜DSML｜ invoke>`,
    "token-bar without call_end": `<|tool▁calls▁begin|><|tool▁call▁begin|>read<|tool▁sep|>{"path":"a.js"}<|tool▁calls▁end|>`,
    "token-bar with a broken JSON body": `<|tool▁calls▁begin|><|tool▁call▁begin|>read<|tool▁sep|>{"path":<|tool▁call▁end|><|tool▁calls▁end|>`,
  };

  for (const [label, content] of Object.entries(CASES)) {
    it(`leaves a ${label} untouched`, async () => {
      const { message, hasTools } = normalizeDeepseekToolCalls({ role: "assistant", content });
      expect(hasTools).toBe(false);
      expect(message.content).toBe(content);

      const chunks = parseChunks(await runStream(upstreamSSE(content)));
      expect(toolCallsOf(chunks)).toHaveLength(0);
      expect(streamedText(chunks)).toBe(content);
    });
  }
});
