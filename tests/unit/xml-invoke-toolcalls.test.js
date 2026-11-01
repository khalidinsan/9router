import { describe, it, expect } from "vitest";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import {
  normalizeXmlInvokeToolCalls,
  hasXmlInvokeToolMarkup,
} from "../../open-sse/utils/xmlInvokeToolParser.js";

/**
 * Kiro's claude-opus-5.5* ids emit their tool calls as XML inside assistant
 * `content` instead of populating `tool_calls`, so the client renders the
 * markup and never runs the tool.
 *
 * The capture below is verbatim from 9router requestDetails.providerResponse
 * (kiro, 2026-10-31), not an approximation.
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

// Same shape without the wrapper, behind the `<get_tool_name>` line Kiro emits.
const UNWRAPPED = `<get_tool_name>read</get_tool_name>
<invoke name="bash">
<parameter name="command">git status --short</parameter>
</invoke>`;

const DECLARED_TOOLS = ["read", "bash", "write", "task"].map((name) => ({
  type: "function",
  function: { name, parameters: { type: "object" } },
}));

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

async function runStream(sse, { model = "claude-opus-5.5-thinking", provider = "kiro", tools = DECLARED_TOOLS, toolChoice } = {}) {
  const body = { messages: [] };
  if (tools) body.tools = tools;
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  const stream = createSSEStream({
    mode: "translate",
    targetFormat: "openai",
    sourceFormat: "openai",
    provider,
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

describe("XML invoke tool-call parsing", () => {
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
    expect(new Set(message.tool_calls.map((call) => call.id)).size).toBe(2);
  });

  it("handles a missing wrapper and the get_tool_name prefix", () => {
    const { message, hasTools } = normalizeXmlInvokeToolCalls({ role: "assistant", content: UNWRAPPED });
    expect(hasTools).toBe(true);
    expect(message.content).toBeUndefined();
    expect(message.tool_calls).toHaveLength(1);
    expect(message.tool_calls[0].function.name).toBe("bash");
    expect(JSON.parse(message.tool_calls[0].function.arguments)).toEqual({ command: "git status --short" });
  });

  it("leaves markup behind leading prose as text", () => {
    const content = `Saya baca dulu controller-nya.\n\n${CAPTURE}`;
    const { hasTools, message } = normalizeXmlInvokeToolCalls({ role: "assistant", content });
    expect(hasTools).toBe(false);
    expect(message.content).toBe(content);
  });

  it("keeps exact parameter values, including quotes and newlines", () => {
    const content = `<function_calls>
<invoke name="write">
<parameter name="path">app/besar.php</parameter>
<parameter name="content">$x = "a";\nif ($x) { echo 'b'; }
</parameter>
</invoke>
<invoke name="bash">
<parameter name="command">npx jest --silent</parameter>
<parameter name="cwd">/x/y</parameter>
<parameter name="timeout">600</parameter>
</invoke>
</function_calls>`;
    const { message } = normalizeXmlInvokeToolCalls({ role: "assistant", content });
    expect(message.tool_calls.map((call) => call.function.name)).toEqual(["write", "bash"]);
    expect(JSON.parse(message.tool_calls[0].function.arguments)).toEqual({
      path: "app/besar.php",
      content: `$x = "a";\nif ($x) { echo 'b'; }\n`,
    });
    expect(JSON.parse(message.tool_calls[1].function.arguments)).toEqual({
      command: "npx jest --silent",
      cwd: "/x/y",
      timeout: 600,
    });
  });

  it("never replaces tool calls the message already carries", () => {
    const existing = [{ id: "call_real", type: "function", function: { name: "read", arguments: '{"path":"a.js"}' } }];
    const { hasTools, message } = normalizeXmlInvokeToolCalls({ role: "assistant", content: CAPTURE, tool_calls: existing });
    expect(hasTools).toBe(false);
    expect(message.tool_calls).toEqual(existing);
    expect(message.content).toBe(CAPTURE);
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

/**
 * A complete payload that the model is *showing* is documentation, not an
 * action. Recovery only applies to a standalone call, so anything that marks
 * the markup as an example — a fence, an inline code span, quotes, or an
 * explanation around it — stays literal text.
 */
describe("example markup stays literal", () => {
  const payload = `<function_calls>
<invoke name="read">
<parameter name="path">/x/a.js</parameter>
</invoke>
</function_calls>`;

  it("leaves a fenced block untouched", () => {
    const content = `Formatnya begini:\n\n\`\`\`xml\n${payload}\n\`\`\`\n\nItu contoh saja.`;
    const { hasTools, message } = normalizeXmlInvokeToolCalls({ role: "assistant", content });
    expect(hasTools).toBe(false);
    expect(message.content).toBe(content);
  });

  it("leaves a quoted payload untouched", () => {
    const content = `Model kadang mengirim "${payload}" sebagai teks.`;
    const { hasTools, message } = normalizeXmlInvokeToolCalls({ role: "assistant", content });
    expect(hasTools).toBe(false);
    expect(message.content).toBe(content);
  });

  it("leaves a payload followed by an explanation untouched", () => {
    const content = `${payload}\n\nPanggilan di atas hanya ilustrasi.`;
    const { hasTools, message } = normalizeXmlInvokeToolCalls({ role: "assistant", content });
    expect(hasTools).toBe(false);
    expect(message.content).toBe(content);
  });

  it("leaves an inline code span untouched", () => {
    const content = `Satu baris: \`<invoke name="read"><parameter name="path">/x/a.js</parameter></invoke>\` selesai.`;
    const { hasTools, message } = normalizeXmlInvokeToolCalls({ role: "assistant", content });
    expect(hasTools).toBe(false);
    expect(message.content).toBe(content);
  });
});

/**
 * A damaged or partial payload is prose. Nothing is synthesized: a missing
 * `</invoke>`, an unclosed `<parameter>`, or an opener whose `<invoke name="`
 * prefix was lost all stay literal rather than becoming a call with guessed
 * arguments.
 */
describe("malformed payloads stay literal", () => {
  it("leaves a truncated payload untouched", () => {
    const content = CAPTURE.replace("</invoke>\n</function_calls>", "");
    const { hasTools, message } = normalizeXmlInvokeToolCalls({ role: "assistant", content });
    expect(hasTools).toBe(false);
    expect(message.content).toBe(content);
  });

  it("leaves an unclosed parameter untouched", () => {
    const content = `<function_calls>
<invoke name="write">
<parameter name="path">/x/a.md</parameter>
<parameter name="content">unterminated
</invoke>
</function_calls>`;
    const { hasTools, message } = normalizeXmlInvokeToolCalls({ role: "assistant", content });
    expect(hasTools).toBe(false);
    expect(message.content).toBe(content);
  });

  it("leaves a damaged opener untouched", () => {
    for (const opener of ['="read">', 'oke name="read">', 'read">', 'write">', 'name="read">']) {
      const content = `Baca.\n\n${opener}\n<parameter name="path">/x/a</parameter>\n</invoke>`;
      const { hasTools, message } = normalizeXmlInvokeToolCalls({ role: "assistant", content });
      expect(hasTools, opener).toBe(false);
      expect(message.content, opener).toBe(content);
    }
  });

  it("leaves prose between two invokes untouched", () => {
    const content = `<invoke name="read">
<parameter name="path">/x/a</parameter>
</invoke>
lalu
<invoke name="read">
<parameter name="path">/x/b</parameter>
</invoke>`;
    const { hasTools, message } = normalizeXmlInvokeToolCalls({ role: "assistant", content });
    expect(hasTools).toBe(false);
    expect(message.content).toBe(content);
  });
});

describe("XML invoke markup never reaches the client", () => {
  it("converts the leaked block into tool_calls in the streaming path", async () => {
    const out = await runStream(upstreamSSE(CAPTURE));
    const chunks = parseChunks(out);
    const withTools = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(withTools).toBeDefined();
    const text = streamedText(chunks);
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
      body: { messages: [], tools: DECLARED_TOOLS },
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

/**
 * Textual recovery is an in-band fallback. A request that declared no tools, or
 * that forbade tool use, must get the model's text verbatim: converting it to
 * `tool_calls` would run a tool the client never offered.
 */
describe("native-vs-inband request behavior", () => {
  it("keeps markup as text when the request declared no tools", async () => {
    const out = await runStream(upstreamSSE(CAPTURE), { tools: null });
    expect(out).toContain("function_calls");
    expect(parseChunks(out).some((c) => c.choices?.[0]?.delta?.tool_calls)).toBe(false);
  });

  it("keeps markup as text when tool_choice is none", async () => {
    const out = await runStream(upstreamSSE(CAPTURE), { toolChoice: "none" });
    expect(out).toContain("function_calls");
    expect(parseChunks(out).some((c) => c.choices?.[0]?.delta?.tool_calls)).toBe(false);
  });
});

/**
 * A tool payload is data, not prose. Before the ceiling was raised, a block
 * larger than 64 KB was released as visible text: production saw a 30k-token
 * `write` call whose markup reached the client, truncated mid-tag.
 */
describe("XML invoke with a payload past the old 64 KB ceiling", () => {
  it("still parses the call instead of leaking the markup", async () => {
    const body = "A".repeat(150_000);
    const block = [
      "<function_calls>",
      '<invoke name="write">',
      '<parameter name="path">app/besar.php</parameter>',
      `<parameter name="content">${body}</parameter>`,
      "</invoke>",
      "</function_calls>",
    ].join("\n");

    const chunk = (delta, finish = null) => ({
      id: "c", object: "chat.completion.chunk", created: 1, model: "claude-opus-5.5-thinking",
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    let sse = "";
    for (let i = 0; i < block.length; i += 8000) {
      sse += `data: ${JSON.stringify(chunk({ content: block.slice(i, i + 8000) }))}\n\n`;
    }
    sse += `data: ${JSON.stringify(chunk({}, "stop"))}\n\n`;
    sse += "data: [DONE]\n\n";

    const out = await runStream(sse);
    expect(out).not.toContain("<parameter");
    expect(out).not.toContain("<invoke");
    const chunks = parseChunks(out);
    const withTools = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls);
    expect(withTools).toBeDefined();
    expect(streamedText(chunks)).not.toContain("AAAA");
  });
});
