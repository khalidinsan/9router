import { describe, expect, it } from "vitest";
import {
  filterQuotasByVisibility,
  getHiddenQuotaRows,
  getPlanLabel,
  parseQuotaData,
  trimHiddenQuotaKeys,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("provider quota visibility", () => {
  const data = {
    quotas: {
      "gemini-pro-agent": {
        displayName: "Gemini 3.1 Pro (High)",
        used: 200,
        total: 1000,
        resetAt: "2026-07-04T00:00:00Z",
        remainingPercentage: 80,
      },
      "claude-opus-4-6-thinking": {
        displayName: "Claude Opus 4.6 (Thinking)",
        used: 100,
        total: 1000,
        resetAt: "2026-07-04T00:00:00Z",
        remainingPercentage: 90,
      },
    },
  };

  it("groups Antigravity model quotas into Gemini and Claude families", () => {
    const quotas = parseQuotaData("antigravity", data);
    expect(quotas.map((q) => q.modelKey)).toEqual([
      "gemini",
      "claude",
    ]);
    expect(quotas[0].name).toBe("Gemini (Flash / Pro)");
    expect(quotas[1].name).toBe("Claude (Sonnet / Opus)");
  });

  it("shows all quotas by default and hides configured provider rows", () => {
    const quotas = parseQuotaData("antigravity", data);
    expect(filterQuotasByVisibility("antigravity", quotas, {})).toHaveLength(2);

    const visibility = {
      antigravity: { hidden: ["claude"] },
    };
    const visible = filterQuotasByVisibility("antigravity", quotas, visibility);
    const hidden = getHiddenQuotaRows("antigravity", quotas, visibility);

    expect(visible.map((q) => q.modelKey)).toEqual(["gemini"]);
    expect(hidden.map((q) => q.modelKey)).toEqual(["claude"]);
  });

  it("trims stale or obsolete model keys", () => {
    const quotas = parseQuotaData("antigravity", data);
    const trimmed = trimHiddenQuotaKeys(["claude", "stale-model-xyz", "gemini-3.8-flash-low"], quotas);
    expect(trimmed).toEqual(["claude"]);

    const visibility = {
      antigravity: { hidden: ["claude", "stale-model-xyz"] },
    };
    const visible = filterQuotasByVisibility("antigravity", quotas, visibility);
    const hidden = getHiddenQuotaRows("antigravity", quotas, visibility);

    expect(visible.map((q) => q.modelKey)).toEqual(["gemini"]);
    expect(hidden.map((q) => q.modelKey)).toEqual(["claude"]);
  });

  it("does not apply one provider hidden list to another provider", () => {
    const quotas = parseQuotaData("antigravity", data);
    const visibility = {
      codex: { hidden: ["gemini"] },
    };
    expect(filterQuotasByVisibility("antigravity", quotas, visibility)).toHaveLength(2);
  });
});

describe("provider plan label", () => {
  it("surfaces a real plan name (Command Code GOAT)", () => {
    expect(getPlanLabel({ plan: "GOAT" }, "commandcode")).toBe("GOAT");
    expect(getPlanLabel({ plan: "Pro" }, "commandcode")).toBe("Pro");
    expect(getPlanLabel({ plan: "Go" }, "commandcode")).toBe("Go");
  });

  it("reports Codex plan types and Claude subscription plans as-is", () => {
    expect(getPlanLabel({ plan: "plus" }, "codex")).toBe("plus");
    expect(getPlanLabel({ plan: "max" }, "claude")).toBe("max");
  });

  it("drops a plan that only echoes the provider name", () => {
    // commandcode falls back to its own name with no subscription; opencode-go
    // always returns its name. A badge repeating the provider is noise.
    expect(getPlanLabel({ plan: "Command Code" }, "commandcode")).toBeNull();
    expect(getPlanLabel({ plan: "OpenCode Go" }, "opencode-go")).toBeNull();
  });

  it("drops placeholder and missing plans", () => {
    expect(getPlanLabel({ plan: "Unknown" }, "claude")).toBeNull();
    expect(getPlanLabel({ plan: "unknown" }, "codex")).toBeNull();
    expect(getPlanLabel({ plan: "N/A" }, "codex")).toBeNull();
    expect(getPlanLabel({ plan: "   " }, "codex")).toBeNull();
    expect(getPlanLabel({ plan: null }, "codex")).toBeNull();
    expect(getPlanLabel({}, "codex")).toBeNull();
    expect(getPlanLabel(undefined, "codex")).toBeNull();
  });
});
