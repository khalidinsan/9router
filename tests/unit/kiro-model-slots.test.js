import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { MITM_TOOLS } from "../../src/shared/constants/cliTools.js";

// Guards Kiro model ids that still need mappable defaultModels slots. Without
// a slot, getMappedModel (src/mitm/server.js) returns null and the request is
// passed through to AWS instead of being routed to the user's chosen provider.
describe("Kiro MITM model slots", () => {
  const kiro = MITM_TOOLS.kiro;

  it("exposes the kiro mitm tool", () => {
    expect(kiro).toBeTruthy();
    expect(kiro.configType).toBe("mitm");
    expect(Array.isArray(kiro.defaultModels)).toBe(true);
  });

  it("offers a mappable slot for the agent default model id 'auto'", () => {
    // اسلات auto برای vibe mode لازمه — وگرنه درخواست میره AWS
    const auto = kiro.defaultModels.find((m) => m.id === "auto");
    expect(auto).toBeTruthy();
    expect(auto.alias).toBe("auto");
  });

  it("offers a mappable slot for Claude Sonnet 5", () => {
    const sonnet5 = kiro.defaultModels.find((m) => m.id === "claude-sonnet-5");
    expect(sonnet5).toBeTruthy();
    expect(sonnet5.alias).toBe("claude-sonnet-5");
  });

  it("offers a mappable slot for the background sub-task model id 'simple-task'", () => {
    const simpleTask = kiro.defaultModels.find((m) => m.id === "simple-task");
    expect(simpleTask).toBeTruthy();
    expect(simpleTask.alias).toBe("simple-task");
  });

  it("offers mappable slots for GPT-5.6 family models", () => {
    const models = new Map(kiro.defaultModels.map((m) => [m.id, m]));
    // Rates are the upstream rateMultiplier in credits, as ListAvailableModels reports them.
    expect(models.get("gpt-5.6-sol")).toMatchObject({ alias: "gpt-5.6-sol", contextLength: 1000000, rateMultiplier: 4.4 });
    expect(models.get("gpt-5.6-terra")).toMatchObject({ alias: "gpt-5.6-terra", contextLength: 1000000, rateMultiplier: 2.2 });
    expect(models.get("gpt-5.6-luna")).toMatchObject({ alias: "gpt-5.6-luna", contextLength: 1000000, rateMultiplier: 1.1 });
  });
});

describe("Kiro static provider models", () => {
  it("includes Claude Sonnet 5 and its synthetic Kiro variants", () => {
    const ids = (PROVIDER_MODELS.kr || []).map((model) => model.id);
    expect(ids).toEqual(expect.arrayContaining([
      "claude-sonnet-5",
      "claude-sonnet-5-thinking",
      "claude-sonnet-5-agentic",
      "claude-sonnet-5-thinking-agentic",
    ]));
  });

  it("includes GPT-5.6 family and synthetic Kiro variants", () => {
    const models = new Map((PROVIDER_MODELS.kr || []).map((model) => [model.id, model]));
    const ids = [...models.keys()];
    expect(ids).toEqual(expect.arrayContaining([
      "gpt-5.6-sol",
      "gpt-5.6-sol-thinking",
      "gpt-5.6-sol-agentic",
      "gpt-5.6-sol-thinking-agentic",
      "gpt-5.6-terra",
      "gpt-5.6-terra-thinking",
      "gpt-5.6-terra-agentic",
      "gpt-5.6-terra-thinking-agentic",
      "gpt-5.6-luna",
      "gpt-5.6-luna-thinking",
      "gpt-5.6-luna-agentic",
      "gpt-5.6-luna-thinking-agentic",
    ]));

    // Rates/context come from the upstream catalog (ListAvailableModels), so
    // they track Kiro's real credit multipliers rather than an estimate.
    for (const [id, rateMultiplier] of [
      ["gpt-5.6-sol", 4.4],
      ["gpt-5.6-sol-thinking", 4.4],
      ["gpt-5.6-sol-agentic", 4.4],
      ["gpt-5.6-sol-thinking-agentic", 4.4],
      ["gpt-5.6-terra", 2.2],
      ["gpt-5.6-terra-thinking", 2.2],
      ["gpt-5.6-terra-agentic", 2.2],
      ["gpt-5.6-terra-thinking-agentic", 2.2],
      ["gpt-5.6-luna", 1.1],
      ["gpt-5.6-luna-thinking", 1.1],
      ["gpt-5.6-luna-agentic", 1.1],
      ["gpt-5.6-luna-thinking-agentic", 1.1],
    ]) {
      const model = models.get(id);
      const upstreamModelId = id.replace(/-(thinking-agentic|thinking|agentic)$/, "");
      expect(model).toMatchObject({
        contextLength: 1000000,
        rateMultiplier,
        upstreamModelId,
      });
    }
  });

  it("covers every upstream catalog model with all four synthetic variants", () => {
    // The registry is the fallback when the live catalog is unreachable, so a
    // model Kiro can serve must never be missing from it.
    const ids = new Set((PROVIDER_MODELS.kr || []).map((model) => model.id));
    const upstream = [
      "auto", "claude-opus-5.5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4.8",
      "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "claude-opus-4.7",
      "claude-opus-4.6", "claude-sonnet-4.6", "claude-opus-4.5", "claude-sonnet-4.5",
      "claude-sonnet-4", "claude-haiku-4.5", "deepseek-3.2", "minimax-m2.5",
      "minimax-m2.1", "glm-5", "qwen3-coder-next",
    ];
    const missing = [];
    for (const id of upstream) {
      // `auto` is server-routed, so Kiro's own docs skip the -agentic variants for it.
      const suffixes = id === "auto" ? ["", "-thinking"] : ["", "-thinking", "-agentic", "-thinking-agentic"];
      for (const suffix of suffixes) {
        if (!ids.has(`${id}${suffix}`)) missing.push(`${id}${suffix}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
