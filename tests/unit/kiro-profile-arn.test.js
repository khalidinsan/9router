import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KiroService } from "../../src/lib/oauth/services/kiro.js";

/**
 * Regression tests for Kiro API-key auth.
 *
 * KiroService.validateApiKey validates against the Amazon Q model catalog and
 * returns an account-bound credential without inventing a profileArn.
 *
 * Note: OAuth (Builder ID / IDC) profileArn resolution is handled upstream by
 * fetchKiroProfileArn in providers.js and is covered there — not here.
 */
describe("kiro API-key auth (KiroService.validateApiKey)", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("validates an API key against Amazon Q without inventing profileArn", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ modelId: "claude-opus-5" }] }),
    });

    const svc = new KiroService();
    const cred = await svc.validateApiKey("  my-secret-key  ");

    expect(cred).toEqual({
      accessToken: "my-secret-key",
      refreshToken: null,
      profileArn: null,
      region: "us-east-1",
      authMethod: "api_key",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://management.us-east-1.kiro.dev/?origin=KIRO_CLI"
    );
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer my-secret-key");
    expect(init.headers.TokenType).toBe("API_KEY");
    expect(init.headers["x-amz-target"]).toBe(
      "KiroControlPlaneBearerService.ListAvailableModels"
    );
    // The request must present the CLI identity, not the desktop IDE.
    expect(init.headers["User-Agent"]).toContain("app/AmazonQ-For-CLI");
    expect(init.headers["User-Agent"]).toContain("api/kirocontrolplanebearer");
    expect(init.headers["User-Agent"]).not.toContain("KiroIDE");
    expect(init.headers["User-Agent"]).not.toContain("kiro-ide");
  });

  it("rejects an empty API key without a network call", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const svc = new KiroService();
    await expect(svc.validateApiKey("   ")).rejects.toThrow("API key is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a validation error when the key is rejected", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    const svc = new KiroService();
    await expect(svc.validateApiKey("bad-key")).rejects.toThrow(
      /API key validation failed/
    );
  });

  it("rejects a 200 response with an empty model catalog", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ models: [] }),
    });
    const svc = new KiroService();
    await expect(svc.validateApiKey("empty-key")).rejects.toThrow(
      /returned no available models/
    );
  });
});
