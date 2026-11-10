import { describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: async ({ credentials, body }) => {
      if (credentials.runtimeTransport?.baseUrl !== "https://agentrouter.org/v1/responses" || !Array.isArray(body.input)) {
        return { response: new Response("wrong upstream endpoint", { status: 400 }), headers: {}, transformedBody: body };
      }
      const events = [
        { type: "response.created", response: { id: "resp_1", model: body.model, created_at: 1, status: "in_progress" } },
        { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "read_file", arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":"a.txt"}' },
        { type: "response.output_item.done", item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "read_file" } },
        { type: "response.completed", response: { id: "resp_1", model: body.model, status: "completed", output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      return { response: new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }), url: credentials.runtimeTransport.baseUrl, headers: {}, transformedBody: body };
    },
  }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({ logRawRequest: vi.fn(), logTargetRequest: vi.fn(), logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(), appendRawChunk: vi.fn(), appendConvertedChunk: vi.fn() }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("../../open-sse/translator/concerns/image.js", () => ({
  encodeDataUri: (type, data) => `data:${type};base64,${data}`,
  parseDataUri: () => null,
  fetchImageAsBase64: async () => null,
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

describe("AgentRouter Responses streaming", () => {
  for (const model of ["gpt-6.1-sol", "gpt-6-astra"]) {
    it(`${model} streams a usable native tool call to chat clients`, async () => {
      const result = await handleChatCore({
        body: { model: `agentrouter/${model}`, stream: true, messages: [{ role: "user", content: "Read a.txt" }], tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } } }] },
        modelInfo: { provider: "agentrouter", model }, credentials: { apiKey: "test", providerSpecificData: {} },
        connectionId: "agentrouter-test", sourceFormatOverride: "openai",
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      });
      expect(result.success).toBe(true);
      const text = await result.response.text();
      const chunks = text.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
      const calls = chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || []);
      expect(calls.some((call) => call.id === "call_1" && call.function?.name === "read_file")).toBe(true);
      expect(JSON.parse(calls.map((call) => call.function?.arguments || "").join(""))).toEqual({ path: "a.txt" });
      expect(chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === "tool_calls")).toBe(true);
    });
  }
});
