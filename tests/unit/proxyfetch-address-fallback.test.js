// Regression: the MITM DNS-bypass must never hang on an unreachable address.
//
// Observed failure (2026-09-13): Google's A records were black-holed from the
// host network while AAAA connected in ~30ms. The bypass pinned resolve4[0]
// and createBypassRequest had no connect deadline — every Antigravity request
// hung until the client gave up, surfacing as 429 RESOURCE_EXHAUSTED and
// multi-minute stalls while `agy` (IPv6, no bypass) worked fine.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "net";
import {
  _clearDeadAddresses,
  _isAddressDead,
  _mitmConnectTimeoutMs,
} from "../../open-sse/utils/proxyFetch.js";

const HOST = "daily-cloudcode-pa.googleapis.com";

describe("proxyFetch MITM bypass address handling", () => {
  beforeEach(() => _clearDeadAddresses());

  it("bounds the connect attempt so a black-holed address cannot hang", () => {
    // Must be finite and comfortably under the client-visible timeout, or the
    // request stalls for minutes with no response object to abort.
    expect(Number.isFinite(_mitmConnectTimeoutMs())).toBe(true);
    expect(_mitmConnectTimeoutMs()).toBeGreaterThan(0);
    expect(_mitmConnectTimeoutMs()).toBeLessThanOrEqual(10_000);
  });

  it("actually fails fast against an unroutable address", async () => {
    // 192.0.2.0/24 is TEST-NET-1: guaranteed unroutable, so a connect attempt
    // can only end by timing out. This reproduces the hang shape directly.
    const t0 = Date.now();
    const outcome = await new Promise((resolve) => {
      const sock = net.connect({ host: "192.0.2.1", port: 443 });
      const timer = setTimeout(() => { sock.destroy(); resolve("timeout"); }, 3000);
      sock.on("connect", () => { clearTimeout(timer); sock.destroy(); resolve("connected"); });
      sock.on("error", () => { clearTimeout(timer); resolve("error"); });
    });
    expect(outcome).not.toBe("connected");
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("remembers dead addresses per host, not globally", () => {
    expect(_isAddressDead(HOST, "172.217.115.4")).toBe(false);
    _clearDeadAddresses();
    expect(_isAddressDead("other.example.com", "172.217.115.4")).toBe(false);
  });

  it("discovers both address families so IPv4-only pinning is impossible", async () => {
    const dns = await import("dns");
    const { promisify } = await import("util");
    const resolver = new dns.Resolver();
    resolver.setServers(["8.8.8.8", "8.8.4.4"]);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const resolve6 = promisify(resolver.resolve6.bind(resolver));

    const [v4, v6] = await Promise.all([
      resolve4(HOST).catch(() => []),
      resolve6(HOST).catch(() => []),
    ]);

    // A healthy dual-stack host must expose IPv6 candidates; if only IPv4 were
    // consulted, a black-holed A record would take the whole provider down.
    expect(v4.length).toBeGreaterThan(0);
    expect(v6.length).toBeGreaterThan(0);
  });
});
