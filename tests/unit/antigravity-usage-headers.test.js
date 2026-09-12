import { describe, it, expect, vi, beforeEach } from "vitest";
import { platform, arch } from "os";

const proxyAwareFetch = vi.fn(async (url) => ({
  ok: true,
  status: 200,
  json: async () => url.includes(":loadCodeAssist")
    ? { cloudaicompanionProject: "project-1", currentTier: { name: "Pro" }, paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } }
    : url.includes(":retrieveUserQuotaSummary")
      ? { groups: [] }
      : { models: {} },
  text: async () => "{}",
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

const AGY_CLI_UA = `antigravity/cli/1.1.27 (aidev_client; os_type=${platform()}; arch=${arch()}; cl=976543523; auth_method=consumer)`;

describe("Antigravity usage headers", () => {
  beforeEach(() => proxyAwareFetch.mockClear());

  it("uses fork usage user agent and keeps MITM bypass source header", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    await getAntigravityUsage("access-token", {});

    // loadCodeAssist + fetchAvailableModels + retrieveUserQuotaSummary (ours)
    // + the weekly-overlay summary read (upstream)
    expect(proxyAwareFetch).toHaveBeenCalledTimes(4);
    const urls = proxyAwareFetch.mock.calls.map(([url]) => url);
    expect(urls.some((u) => u.includes(":retrieveUserQuotaSummary"))).toBe(true);
    for (const [, options] of proxyAwareFetch.mock.calls) {
      expect(options.headers["User-Agent"]).toBe(AGY_CLI_UA);
      expect(options.headers["x-request-source"]).toBe("local");
    }
  });
});
