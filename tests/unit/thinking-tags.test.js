import { describe, it, expect } from "vitest";
import { splitThinkTaggedText, flushThinkTaggedState } from "../../open-sse/translator/concerns/thinkingTags.js";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.js";

describe("splitThinkTaggedText", () => {
  it("routes <thinking> body to reasoning and drops closers", () => {
    const { parts, state } = splitThinkTaggedText(
      "Hi <thinking>plan the edit</thinking> done </thinking>",
      {},
    );
    expect(parts).toEqual([
      { kind: "content", text: "Hi " },
      { kind: "reasoning", text: "plan the edit" },
      { kind: "content", text: " done " },
    ]);
    expect(state.mode).toBeNull();
    expect(state.carry).toBe("");
  });

  it("handles tags split across chunks", () => {
    const acc = { content: "", reasoning: "" };
    let state = {};
    for (const piece of ["pre <thin", "king>secret</thin", "king> after"]) {
      const { parts, state: next } = splitThinkTaggedText(piece, state);
      state = next;
      for (const part of parts) acc[part.kind] += part.text;
    }
    const flushed = flushThinkTaggedState(state);
    for (const part of flushed.parts) acc[part.kind] += part.text;
    expect(acc.content).toBe("pre  after");
    expect(acc.reasoning).toBe("secret");
  });

  it("drops stray </thinking> with no opener", () => {
    const { parts } = splitThinkTaggedText("Saya sudah ubah.\n</thinking>\n</thinking>", {});
    expect(parts).toEqual([{ kind: "content", text: "Saya sudah ubah.\n\n" }]);
  });
});

describe("openaiResponsesToOpenAIResponse think tags", () => {
  it("converts leaked thinking wrappers to reasoning_content", () => {
    const state = {};
    const a = openaiResponsesToOpenAIResponse(
      { type: "response.output_text.delta", delta: "<thinking>need Edit" },
      state,
    );
    const b = openaiResponsesToOpenAIResponse(
      { type: "response.output_text.delta", delta: "</thinking>ok" },
      state,
    );
    const chunks = [a, b].flat().filter(Boolean);
    const reasoning = chunks.map((c) => c.choices?.[0]?.delta?.reasoning_content).filter(Boolean).join("");
    const content = chunks.map((c) => c.choices?.[0]?.delta?.content).filter(Boolean).join("");
    expect(reasoning).toBe("need Edit");
    expect(content).toBe("ok");
  });

  it("stashes encrypted_content from reasoning item.done onto the final chunk", () => {
    const state = {};
    openaiResponsesToOpenAIResponse(
      { type: "response.output_item.done", item: { type: "reasoning", id: "rs_3e3f6187-892a-96db-893b-904eff019e19", encrypted_content: "ENC" } },
      state,
    );
    const done = openaiResponsesToOpenAIResponse(
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } },
      state,
    );
    const chunk = Array.isArray(done) ? done.at(-1) : done;
    expect(chunk.encrypted_content).toBe("ENC");
    expect(chunk.reasoning_id).toBe("rs_3e3f6187-892a-96db-893b-904eff019e19");
  });
});
