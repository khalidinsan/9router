import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";

const MODELS = [
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
];
const PROVIDER = "opencode";

const input = [{
  type: "message",
  role: "user",
  content: [{ type: "input_text", text: "Think, then answer: 2 + 2?" }],
}];

describe("OpenCode Free Muse Spark thinking", () => {
  it.each(MODELS)("advertises reasoning and the requested model limits for %s", (model) => {
    expect(PROVIDER_MODELS.oc?.some((m) => m.id === model)).toBe(true);
    expect(getCapabilitiesForModel(PROVIDER, model)).toMatchObject({
      reasoning: true,
      thinkingFormat: "openai",
      contextWindow: 1048576,
      maxOutput: 131072,
    });
    expect(getCapabilitiesForModel(PROVIDER, `oc/${model}`)).toMatchObject({
      reasoning: true,
      contextWindow: 1048576,
      maxOutput: 131072,
    });
    expect(getThinkingLevels(PROVIDER, model)).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it.each(MODELS)("clamps max to xhigh and emits the Responses reasoning shape for %s", (model) => {
    const body = {
      input,
      reasoning: { effort: "max" },
      max_tokens: 131072,
    };

    const out = new OpenCodeExecutor().transformRequest(model, body, true, {
      connectionId: "opencode-muse-spark-test",
    });

    expect(out.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.max_output_tokens).toBe(131072);
    expect(out.max_tokens).toBeUndefined();
  });

  it("leaves the other free models on Chat Completions", () => {
    const executor = new OpenCodeExecutor();
    const body = { messages: [{ role: "user", content: "hi" }], max_tokens: 1024 };
    executor.transformRequest("big-pickle", body, true, {});
    expect(executor.buildUrl("big-pickle")).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(body.max_tokens).toBe(1024);
    expect(body.max_output_tokens).toBeUndefined();
  });

  it.each(MODELS)("translates Chat Completions max thinking into a Responses request for %s", (model) => {
    const body = {
      model: `oc/${model}`,
      messages: [{ role: "user", content: "Think, then answer: 2 + 2?" }],
      reasoning_effort: "max",
      max_tokens: 131072,
    };

    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      model,
      body,
      true,
      {},
      PROVIDER,
    );
    const out = new OpenCodeExecutor().transformRequest(model, translated, true, {
      connectionId: "opencode-muse-spark-translation-test",
    });

    expect(out.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(out.max_output_tokens).toBe(131072);
    expect(out.max_tokens).toBeUndefined();
  });
});
