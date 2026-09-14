import { describe, it, expect } from "vitest";
import { isModelAllowedOnConnection } from "../../open-sse/services/accountFallback.js";

// Per-account model restriction: "account A is for DeepSeek only".
//
// This is a STANDING preference set by the user, distinct from a model lock
// (a temporary cooldown the router applies itself after an upstream error).
// Rotation is unchanged — an account that allows the model is still rotated to
// normally; this only skips accounts the user excluded for that model.

const conn = (enabledModels) => ({
  id: "c1",
  providerSpecificData: enabledModels === undefined ? {} : { enabledModels },
});

describe("isModelAllowedOnConnection", () => {
  it("allows everything when the field is absent", () => {
    // Default for a connection that has never been configured.
    expect(isModelAllowedOnConnection(conn(undefined), "deepseek-v4.1-flash")).toBe(true);
    expect(isModelAllowedOnConnection({ id: "c" }, "anything")).toBe(true);
  });

  it("allows everything when the list is empty", () => {
    // Empty must mean unrestricted, not "nothing allowed" — otherwise clearing
    // every toggle would strand the account.
    expect(isModelAllowedOnConnection(conn([]), "deepseek-v4.1-flash")).toBe(true);
  });

  it("allows only listed models when restricted", () => {
    const c = conn(["deepseek-v4.1-flash"]);
    expect(isModelAllowedOnConnection(c, "deepseek-v4.1-flash")).toBe(true);
    expect(isModelAllowedOnConnection(c, "gpt-5.6-sol")).toBe(false);
  });

  it("supports several models on one account", () => {
    const c = conn(["deepseek-v4.1-flash", "kimi-k3"]);
    expect(isModelAllowedOnConnection(c, "deepseek-v4.1-flash")).toBe(true);
    expect(isModelAllowedOnConnection(c, "kimi-k3")).toBe(true);
    expect(isModelAllowedOnConnection(c, "gpt-5.6-sol")).toBe(false);
  });

  it("never filters a model-less call", () => {
    // A bare connectivity probe has no model; the restriction is about which
    // model may run, not whether the account works at all.
    expect(isModelAllowedOnConnection(conn(["a"]), null)).toBe(true);
    expect(isModelAllowedOnConnection(conn(["a"]), undefined)).toBe(true);
    expect(isModelAllowedOnConnection(conn(["a"]), "")).toBe(true);
  });

  it("ignores a malformed enabledModels value", () => {
    expect(isModelAllowedOnConnection({ providerSpecificData: { enabledModels: "oops" } }, "m")).toBe(true);
    expect(isModelAllowedOnConnection({ providerSpecificData: { enabledModels: 42 } }, "m")).toBe(true);
  });

  it("handles a missing connection", () => {
    expect(isModelAllowedOnConnection(null, "m")).toBe(true);
    expect(isModelAllowedOnConnection(undefined, "m")).toBe(true);
  });

  it("models the intended split: A for deepseek, B for gpt", () => {
    const accountA = conn(["deepseek-v4.1-flash"]);
    const accountB = conn(["gpt-5.6-sol"]);

    // A deepseek request must only consider A ...
    expect(isModelAllowedOnConnection(accountA, "deepseek-v4.1-flash")).toBe(true);
    expect(isModelAllowedOnConnection(accountB, "deepseek-v4.1-flash")).toBe(false);

    // ... and a gpt request only B.
    expect(isModelAllowedOnConnection(accountB, "gpt-5.6-sol")).toBe(true);
    expect(isModelAllowedOnConnection(accountA, "gpt-5.6-sol")).toBe(false);
  });
});
