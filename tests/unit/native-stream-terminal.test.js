import { describe, expect, it } from "vitest";
import { createSSEStream } from "../../open-sse/utils/stream.js";

const model = "claude-opus-5.5-thinking";
const xml = '<invoke name="read">\n<parameter name="path">/x/a</parameter>\n<parameter name="i">Reading file</parameter>\n</invoke>';
const upstreamError = { message: "Kiro EventStream ended without a terminal event", type: "upstream_error", code: "kiro_missing_terminal" };

async function replay(deltas, { mode = "translate", sourceFormat = "openai", targetFormat = "openai", ending = "finish", transportSize = 4096 } = {}) {
  let completed;
  const stream = createSSEStream({
    mode, sourceFormat, targetFormat, provider: "kiro", model,
    body: { messages: [], tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }] },
    onStreamComplete: value => { completed = value; },
  });
  const chunk = (delta, finish_reason = null) => ({
    id: "chatcmpl-terminal-regression", object: "chat.completion.chunk", created: 1, model,
    choices: [{ index: 0, delta, finish_reason }],
  });
  let input = deltas.map(delta => `data: ${JSON.stringify(chunk(delta))}\n\n`).join("");
  if (ending === "finish") input += `data: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`;
  else if (ending === "done") input += "data: [DONE]\n\n";
  else if (ending === "error") input += `data: ${JSON.stringify({ error: upstreamError })}\n\ndata: [DONE]\n\n`;
  else if (ending === "tail") input = input.trimEnd();
  else if (ending === "line") input = input.trimEnd() + "\n";
  const writer = stream.writable.getWriter();
  const reading = new Response(stream.readable).text();
  const encoded = new TextEncoder().encode(input);
  for (let offset = 0; offset < encoded.length; offset += transportSize) {
    await writer.write(encoded.slice(offset, offset + transportSize));
  }
  await writer.close();
  const output = await reading;
  const data = output.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/)
    .filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n"))
    .filter(Boolean);
  const chunks = data.filter(value => value !== "[DONE]").map(value => JSON.parse(value));
  return { chunks, completed, doneCount: data.filter(value => value === "[DONE]").length };
}

const fieldText = (chunks, field) => chunks.map(chunk => chunk.choices?.[0]?.delta?.[field] || "").join("");

for (const mode of ["translate", "passthrough"]) {
  describe(`${mode}: native stream terminal boundaries`, () => {
    for (const ending of ["finish", "done", "eof", "tail", "line"]) {
      it(`${ending}: preserves pending literal content and reasoning as valid SSE events`, async () => {
        const result = await replay([{ content: "Please rea" }, { reasoning_content: "Thinking <" }], { mode, ending });
        expect(fieldText(result.chunks, "content")).toBe("Please rea");
        expect(fieldText(result.chunks, "reasoning_content")).toBe("Thinking <");
        expect(result.completed).toEqual({ content: "Please rea", thinking: "Thinking <" });
        if (ending !== "finish") expect(result.chunks.some(chunk => chunk.choices?.[0]?.finish_reason)).toBe(false);
        if (ending === "finish" || ending === "done" || mode === "passthrough") expect(result.doneCount).toBe(1);
      });
      it(`${ending}: emits every recovered tool argument before terminal framing`, async () => {
        const result = await replay([{ content: xml }], { mode, ending, transportSize: 7 });
        expect(fieldText(result.chunks, "content")).toBe("");
        const calls = result.chunks.flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls || []);
        expect(calls).toHaveLength(1);
        expect(calls[0].index).toBe(0);
        expect(calls[0].function.name).toBe("read");
        expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: "/x/a", i: "Reading file" });
        expect(result.chunks.find(chunk => chunk.choices?.[0]?.finish_reason)?.choices[0].finish_reason).toBe("tool_calls");
      });
    }
  });
}

for (const sourceFormat of ["claude", "openai-responses"]) {
  for (const ending of ["finish", "done", "eof", "tail"]) {
    it(`kiro to ${sourceFormat}, ${ending}: translates recovered tools before closing the protocol`, async () => {
      const result = await replay([{ content: xml }], { targetFormat: "kiro", sourceFormat, ending });
      expect(result.chunks.every(chunk => chunk.choices === undefined)).toBe(true);
      if (sourceFormat === "claude") {
        const tool = result.chunks.find(chunk => chunk.type === "content_block_start" && chunk.content_block?.type === "tool_use");
        expect(tool?.content_block.name).toBe("read");
        const args = result.chunks.filter(chunk => chunk.index === tool.index && chunk.delta?.type === "input_json_delta")
          .map(chunk => chunk.delta.partial_json).join("");
        expect(JSON.parse(args)).toEqual({ path: "/x/a", i: "Reading file" });
        expect(result.chunks.find(chunk => chunk.type === "message_delta")?.delta.stop_reason).toBe("tool_use");
        expect(result.chunks.at(-1).type).toBe("message_stop");
      } else {
        const tool = result.chunks.find(chunk => chunk.type === "response.output_item.done" && chunk.item?.type === "function_call");
        expect(tool?.item.name).toBe("read");
        expect(JSON.parse(tool.item.arguments)).toEqual({ path: "/x/a", i: "Reading file" });
        expect(result.chunks.at(-1).type).toBe("response.completed");
      }
    });
  }
}

it("kiro to claude: pending plain tails stay inside their text and thinking blocks", async () => {
  const result = await replay([{ reasoning_content: "Thinking <" }, { content: "Please rea" }], { targetFormat: "kiro", sourceFormat: "claude" });
  expect(result.chunks.every(chunk => chunk.choices === undefined)).toBe(true);
  expect(result.chunks.filter(chunk => chunk.delta?.type === "thinking_delta").map(chunk => chunk.delta.thinking).join("")).toBe("Thinking <");
  expect(result.chunks.filter(chunk => chunk.delta?.type === "text_delta").map(chunk => chunk.delta.text).join("")).toBe("Please rea");
  expect(result.chunks.findLastIndex(chunk => chunk.delta?.type === "thinking_delta"))
    .toBeLessThan(result.chunks.findIndex(chunk => chunk.delta?.type === "text_delta"));
  for (const [index, chunk] of result.chunks.entries()) {
    if (chunk.type !== "content_block_stop") continue;
    expect(result.chunks.slice(index + 1).some(later => later.type === "content_block_delta" && later.index === chunk.index)).toBe(false);
  }
});

for (const sourceFormat of ["openai", "claude", "openai-responses"]) {
  it(`kiro to ${sourceFormat}: preserves explicit streaming errors without a successful terminal`, async () => {
    const result = await replay([{ content: "Please rea" }, { reasoning_content: "Thinking <" }], { targetFormat: "kiro", sourceFormat, ending: "error", transportSize: 7 });
    const failure = result.chunks.find(chunk => chunk.error || chunk.response?.error);
    expect(failure?.error || failure?.response?.error).toEqual(upstreamError);
    expect(result.chunks.some(chunk => chunk.choices?.[0]?.finish_reason || chunk.type === "message_stop" || chunk.type === "response.completed")).toBe(false);
    if (sourceFormat === "openai") {
      expect(fieldText(result.chunks, "content")).toBe("Please rea");
      expect(fieldText(result.chunks, "reasoning_content")).toBe("Thinking <");
    } else if (sourceFormat === "claude") {
      expect(result.chunks.at(-1)).toEqual({ type: "error", error: upstreamError });
    } else if (sourceFormat === "openai-responses") {
      expect(result.chunks.at(-1)).toMatchObject({ type: "response.failed", response: { status: "failed", error: upstreamError } });
    }
  });
}

for (const mode of ["translate", "passthrough"]) {
  it(`${mode}: an explicit streaming error never becomes a recovered-tool success`, async () => {
    const result = await replay([{ content: `Baca.\n\n${xml}` }], { mode, ending: "error" });
    expect(result.chunks.find(chunk => chunk.error)?.error).toEqual(upstreamError);
    expect(result.chunks.some(chunk => chunk.choices?.[0]?.finish_reason)).toBe(false);
    expect(result.chunks.at(-1).error).toEqual(upstreamError);
  });
}
