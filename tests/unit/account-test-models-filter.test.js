import { describe, it, expect } from "vitest";

// "Models on this account" (the per-account test panel) is built from the same
// catalog as the "Available Models" section, so it must apply the same
// disabled-model filter. Previously it did not, and listed models the provider
// had switched off — which can only fail when tested, and contradicted the list
// rendered directly above it.
//
// The real builder lives inline in providers/[id]/page.js. This mirrors its
// filtering so the rule is pinned by a test rather than only by the page.

function buildAccountTestModels({ models = [], kiloFreeModels = [], customRows = [], disabledModelIds = [] }) {
  const disabledSet = new Set(disabledModelIds);
  const builtIn = models
    .filter((m) => {
      const k = m.kind ?? m.type;
      return (!k || k === "llm") && !disabledSet.has(m.id);
    })
    .map((m) => ({ id: m.id, name: m.name || m.id }));
  const freeExtra = kiloFreeModels
    .filter((fm) => !builtIn.some((m) => m.id === fm.id) && !disabledSet.has(fm.id))
    .map((m) => ({ id: m.id, name: m.name || m.id }));
  const custom = customRows
    .filter((m) => !disabledSet.has(m.id))
    .map((m) => ({ id: m.id, name: m.name || m.id }));

  const seen = new Set();
  const out = [];
  for (const m of [...custom, ...builtIn, ...freeExtra]) {
    if (!m?.id || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

const ids = (rows) => rows.map((r) => r.id);

describe("account test model list respects disabled models", () => {
  const models = [
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "kimi-k3", name: "Kimi K3" },
  ];

  it("includes every model when nothing is disabled", () => {
    expect(ids(buildAccountTestModels({ models }))).toEqual([
      "deepseek-v4.1-flash", "gpt-5.6-sol", "kimi-k3",
    ]);
  });

  it("drops models disabled in Available Models", () => {
    // The regression: these used to appear in the account panel anyway.
    const out = buildAccountTestModels({ models, disabledModelIds: ["gpt-5.6-sol"] });
    expect(ids(out)).toEqual(["deepseek-v4.1-flash", "kimi-k3"]);
    expect(ids(out)).not.toContain("gpt-5.6-sol");
  });

  it("returns an empty list when every model is disabled", () => {
    const out = buildAccountTestModels({
      models,
      disabledModelIds: models.map((m) => m.id),
    });
    expect(out).toEqual([]);
  });

  it("also filters the free-model extras", () => {
    const out = buildAccountTestModels({
      models: [],
      kiloFreeModels: [{ id: "free-a" }, { id: "free-b" }],
      disabledModelIds: ["free-a"],
    });
    expect(ids(out)).toEqual(["free-b"]);
  });

  it("also filters custom models", () => {
    const out = buildAccountTestModels({
      models: [],
      customRows: [{ id: "my-custom" }, { id: "other-custom" }],
      disabledModelIds: ["my-custom"],
    });
    expect(ids(out)).toEqual(["other-custom"]);
  });

  it("still drops non-llm entries", () => {
    const out = buildAccountTestModels({
      models: [
        { id: "chat-model" },
        { id: "embed-model", kind: "embedding" },
        { id: "tts-model", type: "tts" },
      ],
    });
    expect(ids(out)).toEqual(["chat-model"]);
  });

  it("de-duplicates across custom, built-in and free sources", () => {
    const out = buildAccountTestModels({
      models: [{ id: "dup" }],
      kiloFreeModels: [{ id: "dup" }],
      customRows: [{ id: "dup" }],
    });
    expect(ids(out)).toEqual(["dup"]);
  });
});
