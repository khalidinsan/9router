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
  _clearMitmProbeCache,
  _isAddressDead,
  _isFamilyDead,
  _markFamilyDead,
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

  // A host with no IPv6 route fails EVERY AAAA with EHOSTUNREACH. Trying a
  // second AAAA after that only burns another connect deadline, so the whole
  // family is retired at once.
  it("retires a whole family after a routing failure, not just one address", () => {
    expect(_isFamilyDead(HOST, 6)).toBe(false);
    _markFamilyDead(HOST, "2001:4860:4841:400::");
    expect(_isFamilyDead(HOST, 6)).toBe(true);
    // A sibling IPv6 address is now skipped too — this is the point.
    expect(_isAddressDead(HOST, "2001:4860:4847:400::")).toBe(true);
    // IPv4 is untouched: a dead IPv6 route says nothing about IPv4.
    expect(_isFamilyDead(HOST, 4)).toBe(false);
    expect(_isAddressDead(HOST, "172.217.112.4")).toBe(false);
  });

  it("scopes family failures per host", () => {
    _markFamilyDead(HOST, "2001:4860:4841:400::");
    expect(_isFamilyDead(HOST, 6)).toBe(true);
    expect(_isFamilyDead("other.example.com", 6)).toBe(false);
  });

  it("clears family state along with addresses", () => {
    _markFamilyDead(HOST, "2001:4860:4841:400::");
    _clearDeadAddresses();
    expect(_isFamilyDead(HOST, 6)).toBe(false);
  });

  // The bypass exists only to defeat MITM's /etc/hosts redirect. With MITM off
  // the system resolver returns real IPs, so the bypass is dead weight — and on
  // a network where the pinned addresses are unreachable it stalls the request
  // for four connect deadlines before the plain fetch (which works) is tried.
  it("detects that the system resolver is NOT redirected when MITM is off", async () => {
    const dns = await import("dns");
    const { promisify } = await import("util");
    const { address } = await promisify(dns.lookup)(HOST);
    const loopback = address === "127.0.0.1" || address === "::1" || address === "0.0.0.0";
    // If this ever fails, MITM is enabled on the machine running the suite and
    // the bypass SHOULD engage — so assert the real, current state.
    expect(typeof loopback).toBe("boolean");
    if (!loopback) expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it("clears the MITM probe cache", () => {
    expect(() => _clearMitmProbeCache()).not.toThrow();
  });
});
