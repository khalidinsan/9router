import { describe, it, expect } from "vitest";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import {
  normalizeXmlInvokeToolCalls,
  hasXmlInvokeToolMarkup,
} from "../../open-sse/utils/xmlInvokeToolParser.js";
import { nativeToolCallParsersFor } from "../../open-sse/utils/nativeToolCalls.js";

/**
 * Kiro's claude-opus-5.5* ids emit their tool calls as XML inside assistant
 * `content` instead of populating `tool_calls`, so the client renders the
 * markup and never runs the tool.
 *
 * These samples are verbatim captures from 9router
 * requestDetails.providerResponse (kiro, 2026-10-31), not approximations.
 */

const CAPTURE = `<function_calls>
<invoke name="read">
<parameter name="i">Reading Pengajuan controller</parameter>
<parameter name="path">/Users/khalid/Documents/Code/TugasNegara/php/silasidakep/application/controllers/pengajuan/Pengajuan.php:1-140</parameter>
</invoke>
<invoke name="read">
<parameter name="i">Reading Detail controller</parameter>
<parameter name="path">/Users/khalid/Documents/Code/TugasNegara/php/silasidakep/application/controllers/pengajuan/Detail.php</parameter>
</invoke>
</function_calls>`;

// Same shape without the wrapper, plus the garbled opener seen in production.
const UNWRAPPED = `<get_tool_name>read</get_tool_name>
<invoke name="bash">
<parameter name="command">git status --short</parameter>
</invoke>`;

function upstreamSSE(content, model = "claude-opus-5.5-thinking") {
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

async function runStream(sse, { model = "claude-opus-5.5-thinking", provider = "kiro" } = {}) {
  const stream = createSSEStream({
    mode: "translate",
    targetFormat: "openai",
    sourceFormat: "openai",
    provider,
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

function parseChunks(text) {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
    .filter(Boolean);
}

describe("XML invoke tool-call parsing", () => {
  it("is registered for Claude-family ids only", () => {
    expect(nativeToolCallParsersFor("claude-opus-5.5-thinking").length).toBeGreaterThan(0);
    expect(nativeToolCallParsersFor("claude-sonnet-5.5").length).toBeGreaterThan(0);
    expect(nativeToolCallParsersFor("gemini-3.8-flash")).toHaveLength(0);
    expect(nativeToolCallParsersFor("deepseek-v4.1-flash").length).toBeGreaterThan(0);
  });

  it("extracts every invoke from the production capture", () => {
    const { message, hasTools } = normalizeXmlInvokeToolCalls({ role: "assistant", content: CAPTURE });
    expect(hasTools).toBe(true);
    expect(message.content).toBeUndefined();
    expect(message.tool_calls).toHaveLength(2);
    expect(message.tool_calls[0].function.name).toBe("read");
    expect(JSON.parse(message.tool_calls[0].function.arguments)).toEqual({
      i: "Reading Pengajuan controller",
      path: "/Users/khalid/Documents/Code/TugasNegara/php/silasidakep/application/controllers/pengajuan/Pengajuan.php:1-140",
    });
    expect(JSON.parse(message.tool_calls[1].function.arguments).path).toContain("Detail.php");
  });

  it("handles a missing wrapper and the garbled get_tool_name opener", () => {
    const { message, hasTools } = normalizeXmlInvokeToolCalls({ role: "assistant", content: UNWRAPPED });
    expect(hasTools).toBe(true);
    expect(message.content).toBeUndefined();
    expect(message.tool_calls).toHaveLength(1);
    expect(message.tool_calls[0].function.name).toBe("bash");
    expect(JSON.parse(message.tool_calls[0].function.arguments)).toEqual({ command: "git status --short" });
  });

  it("keeps leading prose and drops the markup", () => {
    const { message } = normalizeXmlInvokeToolCalls({
      role: "assistant",
      content: `Saya baca dulu controller-nya.\n\n${CAPTURE}`,
    });
    expect(message.content).toBe("Saya baca dulu controller-nya.");
    expect(message.tool_calls).toHaveLength(2);
  });

  it("recovers a truncated final invoke", () => {
    const truncated = CAPTURE.replace("</invoke>\n</function_calls>", "");
    const { message, hasTools } = normalizeXmlInvokeToolCalls({ role: "assistant", content: truncated });
    expect(hasTools).toBe(true);
    expect(message.tool_calls).toHaveLength(2);
    expect(JSON.parse(message.tool_calls[1].function.arguments).path).toContain("Detail.php");
  });

  it("leaves sample markup alone when no parameters are present", () => {
    const sample = 'Contoh markup-nya: <invoke name="read"> tanpa parameter.';
    expect(hasXmlInvokeToolMarkup(sample)).toBe(true);
    const { hasTools, message } = normalizeXmlInvokeToolCalls({ role: "assistant", content: sample });
    expect(hasTools).toBe(false);
    expect(message.content).toBe(sample);
  });

  it("leaves ordinary prose alone", () => {
    const { hasTools, message } = normalizeXmlInvokeToolCalls({ role: "assistant", content: "Just a reply." });
    expect(hasTools).toBe(false);
    expect(message.content).toBe("Just a reply.");
  });
});

describe("XML invoke markup never reaches the client", () => {
  it("converts the leaked block into tool_calls in the streaming path", async () => {
    const out = await runStream(upstreamSSE(CAPTURE));
    const chunks = parseChunks(out);
    const withTools = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(withTools).toBeDefined();
    const text = chunks.map((c) => c.choices?.[0]?.delta?.content || "").join("");
    expect(text).not.toContain("invoke");
    expect(text).not.toContain("function_calls");
    expect(out).not.toContain("<parameter");
  });

  it("holds a marker split across deltas instead of emitting it as prose", async () => {
    // Split inside the opening tag and again inside a parameter.
    const pieces = ["<function_ca", "lls>\n<invoke na", 'me="read">\n<parameter name="path">', "a.js</parameter>\n</invoke>\n</function_calls>"];
    const encoder = new TextEncoder();
    const stream = createSSEStream({
      mode: "translate",
      targetFormat: "openai",
      sourceFormat: "openai",
      provider: "kiro",
      model: "claude-opus-5.5-thinking",
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
    const chunk = (delta, finish = null) => ({
      id: "c", object: "chat.completion.chunk", created: 1, model: "claude-opus-5.5-thinking",
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    for (const p of pieces) {
      await writer.write(encoder.encode(`data: ${JSON.stringify(chunk({ content: p }))}\n\n`));
    }
    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`));
    await writer.write(encoder.encode("data: [DONE]\n\n"));
    await writer.close();
    const out = await pump;

    expect(out).not.toContain("<function_ca");
    expect(out).not.toContain("<parameter");
    const chunks = parseChunks(out);
    const withTools = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(withTools).toBeDefined();
    expect(withTools.choices[0].delta.tool_calls[0].function.name).toBe("read");
  });

  it("leaves a non-Claude model's markup untouched", async () => {
    const out = await runStream(upstreamSSE(CAPTURE, "gemini-3.8-flash"), { model: "gemini-3.8-flash", provider: "antigravity" });
    expect(out).toContain("function_calls");
  });
});
