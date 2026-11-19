import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn().mockResolvedValue(),
  saveRequestDetail: vi.fn().mockResolvedValue(),
  saveRequestUsage: vi.fn().mockResolvedValue(),
  trackPendingRequest: vi.fn().mockResolvedValue(),
}));

import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { formatDoneLine } from "../../open-sse/handlers/chatCore/requestDetail.js";

const model = "deepseek/deepseek-v4.1-flash";
const chunk = (delta, finish_reason = null) => ({
  id: "chatcmpl-commandcode-test", object: "chat.completion.chunk", created: 1, model,
  choices: [{ index: 0, delta, finish_reason }],
});
const frame = value => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;

async function responseFor(input) {
  const bytes = new TextEncoder().encode(input);
  const source = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13));
      controller.close();
    },
  });
  const abort = new AbortController();
  const streamController = {
    signal: abort.signal, startTime: Date.now(), isConnected: () => true,
    handleComplete: vi.fn(), handleError: vi.fn(), handleDisconnect: vi.fn(), abort: () => abort.abort(),
  };
  const completed = vi.fn();
  const result = await handleStreamingResponse({
    providerResponse: new Response(source, { headers: { "Content-Type": "text/event-stream" } }),
    provider: "commandcode-provider", model, sourceFormat: "openai", targetFormat: "openai",
    body: { messages: [{ role: "user", content: "Use the tool" }] }, stream: true,
    requestStartTime: Date.now(), streamController, onStreamComplete: completed,
  });
  return { response: result.response, completed };
}

async function readEvents(response) {
  const text = await response.text();
  return text.split(/\r?\n\r?\n/).flatMap(event => {
    const line = event.split(/\r?\n/).find(part => part.startsWith("data:"));
    const value = line?.slice(5).trim();
    return value && value !== "[DONE]" ? [JSON.parse(value)] : [];
  });
}

describe("Command Code streaming usage", () => {
  const tool = { tool_calls: [{ index: 0, id: "call_12345678", type: "function", function: { name: "read", arguments: '{"path":"/tmp/example"}' } }] };

  it("attaches the real cache and output trailer before finish and records it even if the client stops there", async () => {
    const actual = { prompt_tokens: 1000000, completion_tokens: 42, total_tokens: 1000042,
      prompt_tokens_details: { cached_tokens: 999000 }, completion_tokens_details: { reasoning_tokens: 12 } };
    const input = frame(chunk(tool)) + frame(chunk({}, "tool_calls")) +
      frame({ id: "chatcmpl-commandcode-test", object: "chat.completion.chunk", created: 1, model, choices: [], usage: actual }) + frame("[DONE]");
    const { response, completed } = await responseFor(input);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes('"finish_reason":"tool_calls"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    const events = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    const finish = events.find(event => event.choices?.[0]?.finish_reason);
    expect(finish.usage.completion_tokens).toBe(42);
    expect(finish.usage.prompt_tokens_details.cached_tokens).toBe(999000);
    expect(finish.usage.estimated).toBeUndefined();
    expect(completed).toHaveBeenCalledOnce();
    expect(completed.mock.calls[0][1]).toMatchObject({ prompt_tokens: 1000000, completion_tokens: 42, cached_tokens: 999000 });
    await reader.cancel();
  });

  it("labels a tool-only fallback as estimated when upstream sends no usage", async () => {
    const { response, completed } = await responseFor(frame(chunk(tool)) + frame(chunk({}, "tool_calls")) + frame("[DONE]"));

    const events = await readEvents(response);
    const usage = events.find(event => event.choices?.[0]?.finish_reason).usage;
    expect(usage.estimated).toBe(true);
    expect(usage.completion_tokens).toBeGreaterThan(0);
    expect(completed.mock.calls[0][1]).toMatchObject({ completion_tokens: usage.completion_tokens, estimated: true });
    expect(formatDoneLine({ usage, latency: { total: 1 } })).toContain("ESTIMATED");
  });
  it("preserves usage already attached to the finish event", async () => {
    const actual = { prompt_tokens: 3889, completion_tokens: 37, total_tokens: 3926,
      prompt_tokens_details: { cached_tokens: 3840 } };
    const finish = { ...chunk({}, "tool_calls"), usage: actual };
    const { response, completed } = await responseFor(frame(chunk(tool)) + frame(finish) + frame("[DONE]"));
    const events = await readEvents(response);
    expect(events.filter(event => event.choices?.[0]?.finish_reason)).toHaveLength(1);
    expect(events.find(event => event.choices?.[0]?.finish_reason).usage).toMatchObject({
      completion_tokens: 37, prompt_tokens_details: { cached_tokens: 3840 },
    });
    expect(completed.mock.calls[0][1]).toMatchObject({ prompt_tokens: 3889, completion_tokens: 37, cached_tokens: 3840 });
  });

  it("does not turn an error after a finish into a successful finish", async () => {
    const error = { message: "upstream interrupted", type: "upstream_error" };
    const { response } = await responseFor(frame(chunk(tool)) + frame(chunk({}, "tool_calls")) + frame({ error }) + frame("[DONE]"));
    const events = await readEvents(response);
    expect(events.some(event => event.choices?.[0]?.finish_reason)).toBe(false);
    expect(events.find(event => event.error)?.error).toEqual(error);
  });
});
