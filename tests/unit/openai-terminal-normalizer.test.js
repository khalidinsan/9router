import { describe, expect, it } from "vitest";

import { finalizeOpenAITerminalSse } from "../../open-sse/providers/openai-terminal-normalizer.js";

function makeFrame(type, data) {
  if (type === "done") return "data: [DONE]";
  if (type === "content") {
    return `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: typeof data === "string" ? data : "" }, finish_reason: null }] })}`;
  }
  if (type === "finish") {
    return `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}`;
  }
  if (type === "usage-only") {
    return `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}`;
  }
  return "";
}

function framesToStream(...frames) {
  const text = frames.map(f => f + "\n\n").join("");
  return new Response(text).body;
}

async function collectFrames(readable) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text.split("\n\n").filter(f => f.trim()).map(f => f.trim());
}

describe("finalizeOpenAITerminalSse", () => {
  it("collapses finish+usage → usage-only → [DONE] → [DONE] to single [DONE] (b.ai pattern)", async () => {
    const stream = framesToStream(
      makeFrame("content", "hi"),
      makeFrame("finish"),
      makeFrame("usage-only"),
      makeFrame("done"),
      makeFrame("done"),
    );
    const frames = await collectFrames(finalizeOpenAITerminalSse(stream));
    const dones = frames.filter(f => f === "data: [DONE]");
    const usageOnly = frames.filter(f => {
      try { const e = JSON.parse(f.slice(5)); return Array.isArray(e.choices) && e.choices.length === 0 && e.usage; } catch { return false; }
    });
    expect(dones).toHaveLength(1);
    expect(usageOnly).toHaveLength(0);
    expect(frames[frames.length - 1]).toBe("data: [DONE]");
  });

  it("preserves normal finish+usage → [DONE] (single done)", async () => {
    const stream = framesToStream(
      makeFrame("content", "hello"),
      makeFrame("finish"),
      makeFrame("done"),
    );
    const frames = await collectFrames(finalizeOpenAITerminalSse(stream));
    const dones = frames.filter(f => f === "data: [DONE]");
    expect(dones).toHaveLength(1);
    expect(frames[frames.length - 1]).toBe("data: [DONE]");
  });

  it("adds [DONE] at EOF when upstream sends none", async () => {
    const stream = framesToStream(
      makeFrame("content", "test"),
      makeFrame("finish"),
    );
    const frames = await collectFrames(finalizeOpenAITerminalSse(stream));
    const dones = frames.filter(f => f === "data: [DONE]");
    expect(dones).toHaveLength(1);
    expect(frames[frames.length - 1]).toBe("data: [DONE]");
  });
});