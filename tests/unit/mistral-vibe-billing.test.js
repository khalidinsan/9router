import { describe, it, expect } from "vitest";
import { getExecutor } from "../../open-sse/executors/index.js";

// A Vibe-type key is metered against the plan's Vibe allowance only when the
// request declares the Vibe Code client. Without that field the very same key is
// gated by the organization's Studio api_budget and answers
// `402 billing_api_budget_exhausted` (2303) while the Vibe budget is untouched.
const body = () => ({
  model: "deepseek-v4-1-flash-1017",
  messages: [{ role: "user", content: "hi" }],
});

const vibeCredentials = () => ({
  apiKey: "mstrl_test",
  providerSpecificData: { authMethod: "browser-sign-in", keyType: "vibe" },
});

describe("Mistral Vibe billing metadata", () => {
  it("marks a Vibe connection's request as Vibe Code traffic", () => {
    const out = getExecutor("mistral").transformRequest(body(), body(), false, vibeCredentials());
    expect(out.metadata).toMatchObject({ call_source: "vibe_code" });
  });

  it("keeps client-supplied metadata alongside the billing marker", () => {
    const incoming = { ...body(), metadata: { client_name: "some-cli", session_id: "abc" } };
    const out = getExecutor("mistral").transformRequest(body(), incoming, false, vibeCredentials());
    expect(out.metadata).toMatchObject({ client_name: "some-cli", session_id: "abc", call_source: "vibe_code" });
  });

  it("leaves a Studio key's request untouched", () => {
    const out = getExecutor("mistral").transformRequest(body(), body(), false, { apiKey: "studio_key", providerSpecificData: {} });
    expect(out.metadata).toBeUndefined();
  });

  it("adds nothing for providers that do not bill this way", () => {
    const out = getExecutor("groq").transformRequest(body(), body(), false, vibeCredentials());
    expect(out.metadata).toBeUndefined();
  });
});
