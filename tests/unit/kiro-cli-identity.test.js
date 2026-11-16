// Regression: every Kiro surface must present the kiro-cli identity, not the
// desktop IDE's.
//
// CAPTURED below is the chat User-Agent pair from a live macOS kiro-cli 3.3.0
// request, so that block is a hard contract: if the IDE fingerprint
// (`KiroIDE`, `kiro-ide`, `AWS-SDK-JS`, `x-amzn-codewhisperer-machine-id`)
// creeps back in, or the CLI version regresses, these assertions fail.
//
// The control-plane, usage, and refresh strings were NOT observed on 3.3.0;
// they are DERIVED from the 2.24.1 capture re-stamped with the 3.3.0
// SDK/Rust/CLI versions. They are kept separate so nobody mistakes inference
// for a capture — the assertion still guards against IDE drift and against
// the two headers merging.
//
// Why it matters: an account's client identity is what the upstream scopes
// policy and quota decisions to. Serving an account through the CLI identity
// while the request claims to be the IDE is a mismatch the provider can see.
import { describe, it, expect } from "vitest";
import {
  buildKiroCliChatHeaders,
  buildKiroCliControlPlaneHeaders,
  buildKiroCliUsageHeaders,
  kiroCliRefreshUserAgent,
  KIRO_CLI_ORIGIN,
  kiroCliManagementHost,
} from "../../open-sse/config/kiroClient.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";

// Ground truth from the live 3.3.0 CLI (first captured chat attempt).
const CAPTURED = {
  chatUA: "aws-sdk-rust/1.6.0 ua/2.1 api/codewhispererstreaming/0.1.19636 os/macos lang/rust/1.94.1 md/appVersion-3.3.0 app/AmazonQ-For-CLI",
  chatXAU: "aws-sdk-rust/1.6.0 ua/2.1 api/codewhispererstreaming/0.1.19636 os/macos lang/rust/1.94.1 m/F app/AmazonQ-For-CLI",
};

// Expected, not captured: these surfaces were not re-observed on 3.3.0.
const DERIVED = {
  controlPlaneUA: "aws-sdk-rust/1.6.0 ua/2.1 api/kirocontrolplanebearer/0.1.0 os/macos lang/rust/1.94.1 md/appVersion-3.3.0 app/AmazonQ-For-CLI",
  controlPlaneXAU: "aws-sdk-rust/1.6.0 ua/2.1 api/kirocontrolplanebearer/0.1.0 os/macos lang/rust/1.94.1 m/F,C app/AmazonQ-For-CLI",
  usageUA: "aws-sdk-rust/1.6.0 ua/2.1 api/codewhispererruntime/0.1.19636 os/macos lang/rust/1.94.1 md/appVersion-3.3.0 app/AmazonQ-For-CLI",
  usageXAU: "aws-sdk-rust/1.6.0 ua/2.1 api/codewhispererruntime/0.1.19636 os/macos lang/rust/1.94.1 m/F app/AmazonQ-For-CLI",
  refreshUA: "kiro-cli/3.3.0",
};

// Anything matching these is the desktop-IDE fingerprint.
const IDE_MARKERS = ["KiroIDE", "kiro-ide", "AWS-SDK-JS", "aws-sdk-js", "kiro-desktop"];

describe("Kiro identity is the CLI, byte-for-byte", () => {
  it("builds the chat User-Agent exactly as kiro-cli 3.3.0 sends it", () => {
    const headers = buildKiroCliChatHeaders();
    expect(headers["User-Agent"]).toBe(CAPTURED.chatUA);
    expect(headers["X-Amz-User-Agent"]).toBe(CAPTURED.chatXAU);
  });

  it("builds the control-plane User-Agent from the same CLI components", () => {
    const headers = buildKiroCliControlPlaneHeaders();
    expect(headers["User-Agent"]).toBe(DERIVED.controlPlaneUA);
    expect(headers["X-Amz-User-Agent"]).toBe(DERIVED.controlPlaneXAU);
  });

  it("builds the usage User-Agent from the same CLI components", () => {
    const headers = buildKiroCliUsageHeaders();
    expect(headers["User-Agent"]).toBe(DERIVED.usageUA);
    expect(headers["X-Amz-User-Agent"]).toBe(DERIVED.usageXAU);
  });

  it("refreshes tokens as the CLI version, not as the IDE", () => {
    // The social refresh uses a plain HTTP client, so the UA is just the
    // version string and must track the CLI version.
    expect(kiroCliRefreshUserAgent()).toBe(DERIVED.refreshUA);
  });

  it("splits metrics and appVersion across the two UA headers", () => {
    // The SDK puts business metrics in X-Amz-User-Agent and md/appVersion in
    // User-Agent. Sending both in one header (or neither) is not the CLI.
    const chat = buildKiroCliChatHeaders();
    expect(chat["User-Agent"]).toContain("md/appVersion-");
    expect(chat["User-Agent"]).not.toContain("m/F");
    expect(chat["X-Amz-User-Agent"]).toContain("m/F");
    expect(chat["X-Amz-User-Agent"]).not.toContain("md/appVersion-");
  });

  it("lets KIRO_CLIENT_VERSION move the CLI version on every surface", () => {
    const original = process.env.KIRO_CLIENT_VERSION;
    try {
      process.env.KIRO_CLIENT_VERSION = "9.9.9";
      expect(kiroCliRefreshUserAgent()).toBe("kiro-cli/9.9.9");
      expect(buildKiroCliChatHeaders()["User-Agent"]).toContain("md/appVersion-9.9.9");
      expect(buildKiroCliChatHeaders()["X-Amz-User-Agent"]).not.toContain("appVersion");
      expect(buildKiroCliUsageHeaders()["User-Agent"]).toContain("md/appVersion-9.9.9");
    } finally {
      // Never leak the override into other tests.
      if (original === undefined) delete process.env.KIRO_CLIENT_VERSION;
      else process.env.KIRO_CLIENT_VERSION = original;
    }
    expect(buildKiroCliChatHeaders()["User-Agent"]).toBe(CAPTURED.chatUA);
  });

  it("never leaks a desktop-IDE marker on any surface", () => {
    const surfaces = [
      buildKiroCliChatHeaders(),
      buildKiroCliControlPlaneHeaders(),
      buildKiroCliUsageHeaders(),
    ];
    for (const headers of surfaces) {
      for (const [name, value] of Object.entries(headers)) {
        for (const marker of IDE_MARKERS) {
          expect(value, `${name} must not contain ${marker}`).not.toContain(marker);
        }
      }
    }
  });

  it("uses the CLI origin marker and control-plane host", () => {
    expect(KIRO_CLI_ORIGIN).toBe("KIRO_CLI");
    expect(kiroCliManagementHost()).toBe("https://management.us-east-1.kiro.dev");
    expect(kiroCliManagementHost("eu-central-1")).toBe("https://management.eu-central-1.kiro.dev");
  });

  it("ships the CLI fingerprint through the provider registry", () => {
    // The executor spreads PROVIDERS.kiro.headers, so a regression here would
    // silently restore the IDE identity on every chat request.
    const headers = PROVIDERS.kiro?.headers || {};
    expect(headers["User-Agent"]).toBe(CAPTURED.chatUA);
    expect(headers["X-Amz-User-Agent"]).toBe(CAPTURED.chatXAU);
  });
});
