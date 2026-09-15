// Antigravity large streaming payloads can wait longer than the small-request
// headers budget for upstream prefill. A no-response timeout is a 504, not a
// 502, and it must rotate without locking accounts that never answered.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");
const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
const { default: antigravity } = await import("../../open-sse/providers/registry/antigravity.js");
const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

const MODEL = "gemini-3.8-flash-high";

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
});

describe("upstream header timeout", () => {
  it("reports a no-response timeout as 504 instead of a 502 network error", async () => {
    const executor = new BaseExecutor("test", {
      baseUrl: "https://example.test/api",
      timeoutMs: 5,
      retry: {
        502: { attempts: 0 },
        504: { attempts: 0 },
      },
    });
    fetchMock.mockImplementationOnce(
      (url, { signal }) =>
        new Promise((resolve, reject) => {
          const fail = () => reject(signal.reason);
          if (signal?.aborted) fail();
          else signal?.addEventListener("abort", fail, { once: true });
        }),
    );

    const failure = await executor
      .execute({ model: MODEL, body: {}, stream: true, credentials: {} })
      .then(() => null, (error) => error);

    expect(failure).toMatchObject({
      name: "UpstreamHeaderTimeoutError",
      code: "UPSTREAM_HEADER_TIMEOUT",
      status: 504,
      timeoutMs: 5,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets a caller abort through unchanged", async () => {
    const executor = new BaseExecutor("test", {
      baseUrl: "https://example.test/api",
      timeoutMs: 5_000,
      retry: { 502: { attempts: 0 } },
    });
    const controller = new AbortController();
    controller.abort();
    const callerAbort = Object.assign(new Error("caller cancelled"), { name: "AbortError" });
    fetchMock.mockRejectedValueOnce(callerAbort);

    const failure = await executor
      .execute({ model: MODEL, body: {}, stream: true, credentials: {}, signal: controller.signal })
      .then(() => null, (error) => error);

    expect(failure).toBe(callerAbort);
  });

  it("scales Antigravity's streamed headers budget for megabyte payloads", () => {
    const executor = new AntigravityExecutor();
    const small = executor.getHeaderTimeoutMs({ stream: true, requestBytes: 1_024 });

    expect(small).toBe(antigravity.transport.timeoutMs);
    expect(executor.getHeaderTimeoutMs({ stream: false, requestBytes: 2 * 1024 * 1024 })).toBe(small);

    const large = executor.getHeaderTimeoutMs({ stream: true, requestBytes: 2 * 1024 * 1024 });
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThanOrEqual(60_000);
  });

  it("records a no-response timeout without locking the account", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      { id: "ag-1", email: "ag-1@example.com", isActive: true, backoffLevel: 5 },
    ]);

    const result = await markAccountUnavailable(
      "ag-1",
      504,
      "No response headers within 60000ms",
      "antigravity",
      MODEL,
      null,
      { transientUpstreamTimeout: true },
    );

    expect(result).toMatchObject({ shouldFallback: true, cooldownMs: 0 });
    expect(dbMocks.updateProviderConnection).toHaveBeenCalledTimes(1);
    const update = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(update).toMatchObject({ errorCode: 504 });
    expect(update).not.toHaveProperty("testStatus");
    expect(Object.keys(update).some((key) => key.startsWith("modelLock_"))).toBe(false);
  });
});
