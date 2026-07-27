import { describe, expect, it, vi } from "vitest";
import { probeGrokCliConnection } from "../../src/shared/services/grokCliProbe.js";

function deps(fetchImpl) {
  let now = 1_000;
  return {
    now: () => (now += 10),
    proxyAwareFetch: fetchImpl,
    resolveConnectionProxyConfig: vi.fn(async () => ({})),
    shouldRefreshCredentials: vi.fn(() => false),
    refreshProviderCredentials: vi.fn(),
  };
}

const connection = {
  id: "conn-1",
  provider: "grok-cli",
  accessToken: "secret-access-token",
  email: "probe@example.com",
  providerSpecificData: { userId: "user-1" },
};

describe("isolated Grok CLI probe", () => {
  it("posts a deterministic bounded request directly to Responses API", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n' +
      'event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } }
    ));

    const result = await probeGrokCliConnection(connection, "grok-4.5", deps(fetchImpl));
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.tokenFingerprint).toHaveLength(12);
    expect(JSON.stringify(result)).not.toContain(connection.accessToken);

    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(options.headers.Authorization).toBe(`Bearer ${connection.accessToken}`);
    expect(options.headers["x-email"]).toBeUndefined();
    expect(options.headers["x-userid"]).toBeUndefined();
    expect(options.headers["x-grok-session-id"]).toBeUndefined();
    expect(JSON.parse(options.body)).toEqual({
      model: "grok-4.5",
      input: "hi",
      stream: true,
      store: false,
      max_output_tokens: 16,
    });
  });

  it("can disable refresh for mutation-free recovery dry runs", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      'event: response.completed\ndata: {"type":"response.completed","response":{"output":[]}}\n\n',
      { status: 200 }
    ));
    const injected = deps(fetchImpl);
    injected.shouldRefreshCredentials.mockReturnValue(true);
    await probeGrokCliConnection(
      { ...connection, refreshToken: "refresh-token" },
      "grok-4.5",
      { ...injected, refreshCredentials: false }
    );
    expect(injected.refreshProviderCredentials).not.toHaveBeenCalled();
  });

  it("returns upstream 402 without mutating or selecting another account", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ code: "personal-team-blocked:spending-limit", error: "out of credits" }),
      { status: 402, headers: { "content-type": "application/json" } }
    ));
    const original = structuredClone(connection);
    const result = await probeGrokCliConnection(connection, "grok-4.5", deps(fetchImpl));
    expect(result).toMatchObject({ ok: false, status: 402 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(connection).toEqual(original);
  });
});
