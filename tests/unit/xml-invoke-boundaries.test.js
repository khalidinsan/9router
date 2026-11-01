import { describe, it, expect } from "vitest";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { normalizeXmlInvokeToolCalls } from "../../open-sse/utils/xmlInvokeToolParser.js";

const model = "claude-opus-5.5-thinking";
const DECLARED_TOOLS = ["read", "bash", "write"].map((name) => ({
  type: "function",
  function: { name, parameters: { type: "object" } },
}));

async function replay(content, size, mode, body = { messages: [], tools: DECLARED_TOOLS }) {
  const stream = createSSEStream({ mode, targetFormat: "openai", sourceFormat: "openai", provider: "kiro", model, body });
  const writer = stream.writable.getWriter();
  const reading = new Response(stream.readable).text();
  const send = async (delta, finish_reason = null) => writer.write(new TextEncoder().encode(`data: ${JSON.stringify({ id: "chatcmpl-replay", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`));
  if (Array.isArray(content)) {
    for (const fragment of content) await send({ content: fragment });
  } else {
    for (let i = 0; i < content.length; i += size) await send({ content: content.slice(i, i + size) });
  }
  await send({}, "stop");
  await writer.write(new TextEncoder().encode("data: [DONE]\n\n"));
  await writer.close();
  const chunks = (await reading).split("\n").filter(l => l.startsWith("data: ") && !l.includes("[DONE]")).map(l => JSON.parse(l.slice(6)));
  return { text: chunks.map(c => c.choices?.[0]?.delta?.content || "").join(""), calls: chunks.flatMap(c => c.choices?.[0]?.delta?.tool_calls || []), finish: chunks.find(c => c.choices?.[0]?.finish_reason)?.choices[0].finish_reason };
}

describe("XML tool calls across arbitrary SSE boundaries", () => {
  it("preserves two distinct intact calls in a non-streaming response", () => {
    const content = '<function_calls>\n<invoke name="read">\n<parameter name="path">/x/a</parameter>\n</invoke>\n<invoke name="bash">\n<parameter name="command">pwd</parameter>\n<parameter name="timeout">600</parameter>\n</invoke>\n</function_calls>';
    const { message, hasTools } = normalizeXmlInvokeToolCalls({ role: "assistant", content });
    expect(hasTools).toBe(true);
    expect(message.content).toBeUndefined();
    expect(message.tool_calls.map(call => [call.function.name, JSON.parse(call.function.arguments)])).toEqual([
      ["read", { path: "/x/a" }],
      ["bash", { command: "pwd", timeout: 600 }],
    ]);
  });

  for (const mode of ["translate", "passthrough"]) {
    it(`${mode}: preserves released XML-looking prose without unrelated chunk mutations`, async () => {
      const result = await replay(["rea", "l answer."], 1, mode);
      expect(result.text).toBe("real answer.");
      expect(result.calls).toEqual([]);
      expect(result.finish).toBe("stop");
    });

    it(`${mode}: recovers both calls of a standalone wrapped payload`, async () => {
      const content = '<function_calls>\n<invoke name="read">\n<parameter name="path">/Users/khalid/Documents/Code/TugasNegara/NestJS/kependudukan-api/docs/04-tasklist.md:49-75</parameter>\n<parameter name="i">Reading task format example</parameter>\n</invoke>\n<invoke name="read">\n<parameter name="path">skill://antislop-ui</parameter>\n<parameter name="i">Reading antislop UI skill</parameter>\n</invoke>\n</function_calls>';
      for (const size of [1, 7, 13, 40, 90, content.length]) {
        const result = await replay(content, size, mode);
        expect(result.text.trim(), `size=${size}`).toBe("");
        expect(result.calls, `size=${size}`).toHaveLength(2);
        expect(result.calls.map(call => call.function.name)).toEqual(["read", "read"]);
        expect(result.calls.map(call => JSON.parse(call.function.arguments))).toEqual([
          { path: "/Users/khalid/Documents/Code/TugasNegara/NestJS/kependudukan-api/docs/04-tasklist.md:49-75", i: "Reading task format example" },
          { path: "skill://antislop-ui", i: "Reading antislop UI skill" },
        ]);
        expect(new Set(result.calls.map(call => call.id)).size).toBe(2);
        expect(result.calls.map(call => call.index)).toEqual([0, 1]);
        expect(result.finish).toBe("tool_calls");
      }
    });

    it(`${mode}: recovers a standalone payload without the wrapper`, async () => {
      const content = '<invoke name="read">\n<parameter name="path">/x/docs/04-tasklist.md:15-45</parameter>\n<parameter name="i">Reading summary</parameter>\n</invoke>';
      for (const size of [1, 7, 13, 40, 90, content.length]) {
        const result = await replay(content, size, mode);
        expect(result.calls, `size=${size}`).toHaveLength(1);
        expect(result.calls[0].function.name).toBe("read");
        expect(JSON.parse(result.calls[0].function.arguments)).toEqual({ path: "/x/docs/04-tasklist.md:15-45", i: "Reading summary" });
        expect(result.finish).toBe("tool_calls");
      }
    });

    it(`${mode}: keeps a damaged opener as text instead of inventing a call`, async () => {
      for (const opener of ['="read">', 'oke name="read">', 'read">', 'name="read">']) {
        const content = `${opener}\n<parameter name="path">/x/docs/04-tasklist.md:15-45</parameter>\n<parameter name="i">Reading summary</parameter>\n</invoke>`;
        const result = await replay(content, 1, mode);
        expect(result.calls, opener).toEqual([]);
        expect(result.text, opener).toContain('<parameter name="path">');
      }
    });

    it(`${mode}: keeps a payload behind prose as text`, async () => {
      const content = 'Saya baca dulu.\n\n<function_calls>\n<invoke name="read">\n<parameter name="path">/x/a</parameter>\n</invoke>\n</function_calls>';
      const result = await replay(content, 7, mode);
      expect(result.calls).toEqual([]);
      expect(result.text).toContain("<function_calls>");
    });

    it(`${mode}: preserves plain prose at EOF`, async () => {
      for (const content of ["Ordinary words, punctuation > and Unicode: selesai 🦊", "Please read", 'Example: read"> then ordinary text.']) {
        expect((await replay(content, 1, mode)).text).toBe(content);
      }
    });

    it(`${mode}: keeps every argument of a large recovered write`, async () => {
      const payload = "baris 🦊\n".repeat(20_000);
      const content = `<function_calls>\n<invoke name="write">\n<parameter name="path">/x/a.md</parameter>\n<parameter name="content">${payload}</parameter>\n</invoke>\n</function_calls>`;
      const result = await replay(content, 4096, mode);
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].function.name).toBe("write");
      expect(JSON.parse(result.calls[0].function.arguments)).toEqual({ path: "/x/a.md", content: payload });
    });

    it(`${mode}: recovers the shell command without dropping cwd or timeout`, async () => {
      const content = '<invoke name="bash">\n<parameter name="command">npx jest</parameter>\n<parameter name="cwd">/x/y</parameter>\n<parameter name="timeout">600</parameter>\n</invoke>';
      const result = await replay(content, 7, mode);
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].function.name).toBe("bash");
      expect(JSON.parse(result.calls[0].function.arguments)).toEqual({ command: "npx jest", cwd: "/x/y", timeout: 600 });
    });
  }
});
