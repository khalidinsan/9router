import { describe, expect, it } from "vitest";
import { KiroExecutor } from "../../open-sse/executors/kiro.js";
import { KIRO_CODEWHISPERER_TARGET } from "../../open-sse/config/kiroConstants.js";

const RUNTIME = "https://runtime.us-east-1.kiro.dev/";
const CODEWHISPERER = "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse";
const Q = "https://q.us-east-1.amazonaws.com/generateAssistantResponse";

function credentials(authMethod, region = "us-east-1") {
  return { providerSpecificData: { authMethod, region } };
}

function fakeResponse(status) {
  return { ok: false, status, headers: { get: () => null } };
}

function executorWithResponses(...statuses) {
  const executor = new KiroExecutor();
  const calls = [];
  executor.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return fakeResponse(statuses[Math.min(calls.length - 1, statuses.length - 1)]);
  };
  return { executor, calls };
}

describe("Kiro auth-aware endpoint routing", () => {
  const executor = new KiroExecutor();

  it("routes API-key inference through Amazon Q before other surfaces", () => {
    expect(executor.getOrderedBaseUrls(credentials("api_key"))).toEqual([
      Q,
      CODEWHISPERER,
      RUNTIME,
    ]);
  });

  it("routes Builder ID OAuth through Amazon Q first", () => {
    expect(executor.getOrderedBaseUrls(credentials("builder-id"))).toEqual([
      Q,
      CODEWHISPERER,
      RUNTIME,
    ]);
  });

  it("routes external IdP through Amazon Q first", () => {
    expect(executor.getOrderedBaseUrls(credentials("external_idp"))).toEqual([
      Q,
      CODEWHISPERER,
      RUNTIME,
    ]);
  });

  it("routes social CLI OAuth through the runtime root only", () => {
    expect(executor.getOrderedBaseUrls(credentials("google"))).toEqual([RUNTIME]);
    expect(executor.getOrderedBaseUrls(credentials("github"))).toEqual([RUNTIME]);
  });

  it("routes imported CLI tokens through the runtime root only", () => {
    expect(executor.getOrderedBaseUrls(credentials("imported"))).toEqual([RUNTIME]);
  });

  it("regionalizes a covered region for IDC with Q first", () => {
    expect(executor.getOrderedBaseUrls(credentials("idc", "eu-central-1"))).toEqual([
      "https://q.eu-central-1.amazonaws.com/generateAssistantResponse",
      CODEWHISPERER,
      RUNTIME,
    ]);
  });

  it("never builds a host in a region that service does not serve", () => {
    // ap-southeast-1 has no Kiro host; codewhisperer has none outside us-east-1.
    expect(executor.getOrderedBaseUrls(credentials("idc", "ap-southeast-1"))).toEqual([Q, CODEWHISPERER, RUNTIME]);
    expect(executor.getOrderedBaseUrls(credentials("idc", "eu-central-1"))).not.toContain(
      "https://codewhisperer.eu-central-1.amazonaws.com/generateAssistantResponse"
    );
  });

  it("refuses to splice an attacker-controlled region into the hostname", () => {
    // The stored region is interpolated into a host that receives the bearer token.
    const hostile = "x.attacker.tld#";
    for (const authMethod of ["idc", "api_key", "builder-id", "google", "imported"]) {
      for (const url of executor.getOrderedBaseUrls(credentials(authMethod, hostile))) {
        expect(new URL(url).hostname).toMatch(/\.amazonaws\.com$|\.kiro\.dev$/);
        expect(url).not.toContain("attacker");
      }
    }
  });

  it("keeps the base fallback count aligned with the configured chain", () => {
    const baseUrls = executor.getBaseUrls();
    expect(executor.getFallbackCount()).toBe(baseUrls.length);

    for (const authMethod of ["api_key", "builder-id", "idc", "external_idp"]) {
      const ordered = executor.getOrderedBaseUrls(credentials(authMethod));
      expect(ordered).toHaveLength(executor.getFallbackCount());
      expect([...ordered].sort()).toEqual([...baseUrls].sort());
      expect(new Set(ordered).size).toBe(ordered.length);
    }

    for (const authMethod of ["google", "github", "imported"]) {
      const ordered = executor.getOrderedBaseUrls(credentials(authMethod));
      expect(ordered).toEqual([RUNTIME]);
      expect(executor.requestExecutor(credentials(authMethod)).getFallbackCount()).toBe(1);
    }
  });

  it("retries only endpoint/auth-surface failures, not payload-invalid 400s", () => {
    expect(executor.shouldRetry(400, 0)).toBe(false);
    expect(executor.shouldRetry(401, 1)).toBe(true);
    expect(executor.shouldRetry(403, 2)).toBe(false);
    expect(executor.shouldRetry(422, 0)).toBe(false);
  });

  it("builds endpoint-specific headers", () => {
    const auth = { accessToken: "test-key", providerSpecificData: { authMethod: "api_key" } };
    const qHeaders = executor.buildHeaders(auth, true, Q);
    const codeWhispererHeaders = executor.buildHeaders(auth, true, CODEWHISPERER);
    const runtimeHeaders = executor.buildHeaders(auth, true, RUNTIME);

    expect(qHeaders.TokenType).toBe("API_KEY");
    expect(qHeaders["X-Amz-Target"]).toBeUndefined();
    expect(codeWhispererHeaders["X-Amz-Target"]).toBe(KIRO_CODEWHISPERER_TARGET);
    expect(runtimeHeaders["X-Amz-Target"]).toBe(KIRO_CODEWHISPERER_TARGET);
  });

  it("surfaces a social runtime 429 instead of falling back to rejected surfaces", async () => {
    const { executor: social, calls } = executorWithResponses(429, 400);
    const result = await social.execute({
      model: "auto",
      body: {},
      stream: true,
      credentials: credentials("github"),
    });

    expect(calls.map((c) => c.url)).toEqual([RUNTIME]);
    expect(calls[0].headers["X-Amz-Target"]).toBe(KIRO_CODEWHISPERER_TARGET);
    expect(result.response.status).toBe(429);
    expect(result.url).toBe(RUNTIME);
  });

  it("keeps a payload-invalid runtime 400 terminal for social tokens", async () => {
    const { executor: social, calls } = executorWithResponses(400);
    const result = await social.execute({
      model: "auto",
      body: {},
      stream: true,
      credentials: credentials("google"),
    });

    expect(calls.map((c) => c.url)).toEqual([RUNTIME]);
    expect(result.response.status).toBe(400);
  });

  it("surfaces social runtime auth failures for chatCore's refresh path", async () => {
    for (const status of [401, 403]) {
      const { executor: social, calls } = executorWithResponses(status, 400);
      const result = await social.execute({
        model: "auto",
        body: {},
        stream: true,
        credentials: credentials("imported"),
      });

      expect(calls.map((c) => c.url)).toEqual([RUNTIME]);
      expect(result.response.status).toBe(status);
      expect(result.url).toBe(RUNTIME);
    }
  });

  it("keeps cross-surface 429 fallback for api_key accounts", async () => {
    const { executor: apiKey, calls } = executorWithResponses(429);
    const result = await apiKey.execute({
      model: "auto",
      body: {},
      stream: true,
      credentials: { apiKey: "test-key", providerSpecificData: { authMethod: "api_key" } },
    });

    expect(calls.map((c) => c.url)).toEqual([Q, CODEWHISPERER, RUNTIME]);
    expect(result.response.status).toBe(429);
    expect(result.url).toBe(RUNTIME);
  });
});
