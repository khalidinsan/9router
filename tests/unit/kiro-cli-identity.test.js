// Regression: every Kiro surface must present the kiro-cli identity, not the
// desktop IDE's.
//
// The expected strings below are captured from a live kiro-cli 2.24.1 install
// (mitmproxy, 2026-09-27), so this file is the contract: if the IDE
// fingerprint (`KiroIDE`, `kiro-ide`, `AWS-SDK-JS`, `x-amzn-codewhisperer-machine-id`)
// creeps back in, these assertions fail.
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

// Ground truth from the live CLI.
const CAPTURED = {
  chatUA: "aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17975 os/macos lang/rust/1.92.0 md/appVersion-2.24.1 app/AmazonQ-For-CLI",
  chatXAU: "aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17975 os/macos lang/rust/1.92.0 m/F app/AmazonQ-For-CLI",
  controlPlaneUA: "aws-sdk-rust/1.3.15 ua/2.1 api/kirocontrolplanebearer/0.1.0 os/macos lang/rust/1.92.0 md/appVersion-2.24.1 app/AmazonQ-For-CLI",
  controlPlaneXAU: "aws-sdk-rust/1.3.15 ua/2.1 api/kirocontrolplanebearer/0.1.0 os/macos lang/rust/1.92.0 m/F,C app/AmazonQ-For-CLI",
  usageUA: "aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererruntime/0.1.17975 os/macos lang/rust/1.92.0 md/appVersion-2.24.1 app/AmazonQ-For-CLI",
  usageXAU: "aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererruntime/0.1.17975 os/macos lang/rust/1.92.0 m/F app/AmazonQ-For-CLI",
  refreshUA: "kiro-cli/2.24.1",
};

// Anything matching these is the desktop-IDE fingerprint.
const IDE_MARKERS = ["KiroIDE", "kiro-ide", "AWS-SDK-JS", "aws-sdk-js", "kiro-desktop"];

describe("Kiro identity is the CLI, byte-for-byte", () => {
  it("builds the chat User-Agent exactly as kiro-cli sends it", () => {
    const headers = buildKiroCliChatHeaders();
    expect(headers["User-Agent"]).toBe(CAPTURED.chatUA);
    expect(headers["X-Amz-User-Agent"]).toBe(CAPTURED.chatXAU);
  });

  it("builds the control-plane User-Agent exactly as kiro-cli sends it", () => {
    const headers = buildKiroCliControlPlaneHeaders();
    expect(headers["User-Agent"]).toBe(CAPTURED.controlPlaneUA);
    expect(headers["X-Amz-User-Agent"]).toBe(CAPTURED.controlPlaneXAU);
  });

  it("builds the usage User-Agent exactly as kiro-cli sends it", () => {
    const headers = buildKiroCliUsageHeaders();
    expect(headers["User-Agent"]).toBe(CAPTURED.usageUA);
    expect(headers["X-Amz-User-Agent"]).toBe(CAPTURED.usageXAU);
  });

  it("refreshes tokens as kiro-cli, not as the IDE", () => {
    expect(kiroCliRefreshUserAgent()).toBe(CAPTURED.refreshUA);
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
