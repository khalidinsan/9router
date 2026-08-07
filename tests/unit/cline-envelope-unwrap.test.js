import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");

const baseCtx = {
  model: "deepseek/deepseek-v4-flash-0731",
  body: { model: "deepseek/deepseek-v4-flash-0731", messages: [{ role: "user", content: "hi" }] },
  stream: false,
  requestStartTime: Date.now(),
  connectionId: "test-connection",
  apiKey: "test",
  onRequestSuccess: vi.fn(async () => {}),
  trackDone: vi.fn(),
  appendLog: vi.fn(),
  reqLogger: {
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn()
  }
};

const clineEnvelope = {
  data: {
    id: "gen_test",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "Ya" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  },
  success: true
};

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

describe("cline non-streaming envelope unwrap", () => {
  it("unwraps the { data, success } envelope for provider cline", async () => {
    const result = await handleNonStreamingResponse({
      ...baseCtx,
      provider: "cline",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      providerResponse: jsonResponse(clineEnvelope)
    });

    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json).not.toHaveProperty("data");
    expect(json.choices).toHaveLength(1);
    expect(json.choices[0].message.content).toBe("Ya");
    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.usage.prompt_tokens).toBeGreaterThanOrEqual(10);
  });

  it("still unwraps the envelope for clinepass", async () => {
    const result = await handleNonStreamingResponse({
      ...baseCtx,
      provider: "clinepass",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      providerResponse: jsonResponse(clineEnvelope)
    });

    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json).not.toHaveProperty("data");
    expect(json.choices[0].message.content).toBe("Ya");
  });

  it("does not unwrap a plain OpenAI response for cline", async () => {
    const result = await handleNonStreamingResponse({
      ...baseCtx,
      provider: "cline",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      providerResponse: jsonResponse(clineEnvelope.data)
    });

    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("Ya");
    expect(json.object).toBe("chat.completion");
  });
});