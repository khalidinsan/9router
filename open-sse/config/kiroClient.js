/**
 * Kiro client identity — the `kiro-cli` fingerprint.
 *
 * Every Kiro surface (chat, token refresh, usage, model catalog, API-key
 * validation) presents the same client identity here so an account always
 * looks like the official CLI rather than the desktop IDE.
 *
 * The chat values below are captured from a live macOS `kiro-cli` 3.3.0
 * request, not invented. The AWS SDK for Rust assembles its UA from
 * components, so each value has a distinct source:
 *
 *   User-Agent:
 *     aws-sdk-rust/1.6.0           sdk-metadata   the Rust SDK's own version
 *     ua/2.1                       ua-metadata    aws-runtime USER_AGENT_VERSION
 *     api/<service>/<version>      api-metadata   the generated service client's PKG_VERSION
 *     os/macos                     os-metadata    build host OS family
 *     lang/rust/1.94.1             language       rustc used for the release build
 *     md/appVersion-3.3.0          additional     kiro-cli's UserAgentOverrideInterceptor
 *     app/AmazonQ-For-CLI          app-name       the SDK AppName kiro-cli configures
 *
 *   X-Amz-User-Agent: the same string minus `md/`/`appVersion`, plus the
 *   business-metrics token (`m/F` streaming, `m/F,C` control plane).
 *
 * The `api/` segment differs per surface because each calls a different
 * generated client — that is not a fingerprint inconsistency, it is what the
 * real CLI sends.
 *
 * Captured vs. inferred: only the chat surface was captured on 3.3.0. The
 * management (control-plane / usage) and refresh values keep their 2.24.1
 * shape re-stamped with the 3.3.0 SDK, Rust, and CLI versions; they were not
 * re-observed on 3.3.0. Likewise, the runtime generated-client version is
 * inferred from streaming (both ship in one SDK release), not captured.
 *
 * Refresh is the one exception: kiro-cli refreshes social tokens through a
 * plain HTTP client, not the SDK, so it sends a bare `kiro-cli/<version>`.
 *
 * Override with KIRO_CLIENT_VERSION / KIRO_CLIENT_OS when a future CLI release
 * moves these values ahead of the constant here.
 */

// kiro-cli release whose fingerprint this mirrors (captured: macOS 3.3.0).
export const KIRO_CLI_VERSION = "3.3.0";

// Rust SDK version, from `aws-sdk-rust/<version>` in the captured UA.
export const KIRO_CLI_SDK_VERSION = "1.6.0";

// aws-runtime USER_AGENT_VERSION — a protocol constant, not a crate version.
export const KIRO_CLI_UA_VERSION = "2.1";

// rustc used to build the release; the SDK reads it at compile time (captured).
export const KIRO_CLI_RUST_VERSION = "1.94.1";

// Generated service-client versions, one per surface. Only the streaming value
// is captured; the others are carried over from the 2.24.1 capture and were
// not re-observed on 3.3.0.
export const KIRO_CLI_API_STREAMING = "0.1.19636";   // codewhispererstreaming (captured)
export const KIRO_CLI_API_RUNTIME = "0.1.19636";     // codewhispererruntime (inferred, same SDK release)
export const KIRO_CLI_API_CONTROL_PLANE = "0.1.0";   // kirocontrolplanebearer (not re-captured)
export const KIRO_CLI_API_TELEMETRY = "1.0.0";       // toolkittelemetry (not re-captured)

// SDK AppName — kiro-cli still reports its Amazon Q lineage here (captured).
export const KIRO_CLI_APP_NAME = "AmazonQ-For-CLI";

/**
 * The `origin` marker kiro-cli puts in request bodies and query strings.
 * Captured from a live CLI: the IDE sends `AI_EDITOR`, the CLI sends
 * `KIRO_CLI`. This is an identity field, so it moves with the fingerprint.
 */
export const KIRO_CLI_ORIGIN = "KIRO_CLI";

/**
 * Control-plane host kiro-cli uses for usage limits and the model catalog.
 * Inferred from the 2.24.1 capture: the CLI reaches these operations through
 * `management.*.kiro.dev` with an `x-amz-target` header, while the IDE uses
 * the `q.*.amazonaws.com` surfaces. Not re-observed on 3.3.0.
 */
export function kiroCliManagementHost(region = "us-east-1") {
  return `https://management.${region}.kiro.dev`;
}

function envOr(name, fallback) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function kiroCliVersion() {
  return envOr("KIRO_CLIENT_VERSION", KIRO_CLI_VERSION);
}

export function kiroCliOsFamily() {
  return envOr("KIRO_CLIENT_OS", "macos");
}

/**
 * Business-metrics token. Only `X-Amz-User-Agent` carries it — the SDK puts
 * metrics there and appVersion in `User-Agent`, never both in one header.
 */
const BUSINESS_METRICS = {
  streaming: "m/F",
  controlPlane: "m/F,C",
};

/**
 * Build an AWS SDK for Rust User-Agent.
 *
 * @param {object} [options]
 * @param {string} [options.api]  service id for the `api/` segment
 * @param {string} [options.apiVersion]
 * @param {boolean} [options.appVersion] include `md/appVersion-<version>`
 * @param {string}  [options.metrics]  business-metrics token
 */
export function buildKiroCliUserAgent(options = {}) {
  const {
    api = "codewhispererstreaming",
    apiVersion = KIRO_CLI_API_STREAMING,
    appVersion = true,
    metrics = null,
  } = options;

  const parts = [
    `aws-sdk-rust/${KIRO_CLI_SDK_VERSION}`,
    `ua/${KIRO_CLI_UA_VERSION}`,
    `api/${api}/${apiVersion}`,
    `os/${kiroCliOsFamily()}`,
    `lang/rust/${KIRO_CLI_RUST_VERSION}`,
  ];
  if (metrics) parts.push(metrics);
  if (appVersion) parts.push(`md/appVersion-${kiroCliVersion()}`);
  parts.push(`app/${KIRO_CLI_APP_NAME}`);
  return parts.join(" ");
}

/**
 * `X-Amz-User-Agent` for the same surface — the same parts, but carrying the
 * business-metrics token instead of `md/appVersion`. The SDK splits them this
 * way, so both headers differ by more than whitespace.
 */
export function buildKiroCliAmzUserAgent(options = {}) {
  return buildKiroCliUserAgent({ ...options, appVersion: false });
}

/** `User-Agent` for the `generateAssistantResponse` chat surface. */
export function kiroCliChatUserAgent() {
  return buildKiroCliUserAgent({
    api: "codewhispererstreaming",
    apiVersion: KIRO_CLI_API_STREAMING,
  });
}

/** `User-Agent` for the CodeWhisperer control-plane surface (usage limits). */
export function kiroCliControlPlaneUserAgent() {
  return buildKiroCliUserAgent({
    api: "codewhispererruntime",
    apiVersion: KIRO_CLI_API_RUNTIME,
  });
}

/**
 * UA for token refresh. kiro-cli's social refresh goes through a plain HTTP
 * client, so it does not carry the SDK component string — just
 * `kiro-cli/<version>`, which follows KIRO_CLIENT_VERSION. Not re-captured on
 * 3.3.0; the shape is carried over from the 2.24.1 capture.
 */
export function kiroCliRefreshUserAgent() {
  return `kiro-cli/${kiroCliVersion()}`;
}

/**
 * Chat headers, matching the captured kiro-cli 3.3.0 streaming request
 * (`GenerateAssistantResponse`): `User-Agent` carries `md/appVersion-3.3.0`,
 * `X-Amz-User-Agent` carries `m/F`.
 *
 * Deliberately absent vs. the IDE fingerprint we used before:
 *   - `x-amzn-codewhisperer-machine-id: kiro-desktop` — an IDE-only marker.
 *   - `x-amz-sso-bearer` — not sent by kiro-cli.
 * `x-amzn-kiro-agent-mode: spec` is kept: kiro-cli sends agent mode through
 * the request body (`additionalModelRequestFields.agentMode`), and the
 * deprecated runtime path needs the header to accept modern payloads.
 */
export function buildKiroCliChatHeaders() {
  return {
    "User-Agent": kiroCliChatUserAgent(),
    "X-Amz-User-Agent": buildKiroCliAmzUserAgent({
      api: "codewhispererstreaming",
      apiVersion: KIRO_CLI_API_STREAMING,
      metrics: BUSINESS_METRICS.streaming,
    }),
    "x-amzn-codewhisperer-optout": "false",
  };
}

/**
 * Headers for the control plane (`management.*.kiro.dev`): usage limits and
 * the model catalog. The UA declares `api/kirocontrolplanebearer`, which is
 * what kiro-cli sends for these operations. Not re-captured on 3.3.0: the
 * generated-client version and `m/F,C` metrics token are carried over from
 * the 2.24.1 capture, with the SDK/Rust/CLI versions updated.
 */
export function buildKiroCliControlPlaneHeaders() {
  return {
    "User-Agent": buildKiroCliUserAgent({
      api: "kirocontrolplanebearer",
      apiVersion: KIRO_CLI_API_CONTROL_PLANE,
    }),
    "X-Amz-User-Agent": buildKiroCliAmzUserAgent({
      api: "kirocontrolplanebearer",
      apiVersion: KIRO_CLI_API_CONTROL_PLANE,
      metrics: BUSINESS_METRICS.controlPlane,
    }),
    "x-amzn-codewhisperer-optout": "false",
  };
}

/**
 * Headers for the CodeWhisperer usage surface (`GetUsageLimits`). kiro-cli
 * reaches this through the control-plane host too, but the UA declares
 * `api/codewhispererruntime` — the generated client that owns the operation.
 * Not re-captured on 3.3.0; `api/codewhispererruntime/0.1.19636` is inferred
 * from the streaming capture's SDK release.
 */
export function buildKiroCliUsageHeaders() {
  return {
    "User-Agent": kiroCliControlPlaneUserAgent(),
    "X-Amz-User-Agent": buildKiroCliAmzUserAgent({
      api: "codewhispererruntime",
      apiVersion: KIRO_CLI_API_RUNTIME,
      metrics: BUSINESS_METRICS.streaming,
    }),
    "x-amzn-codewhisperer-optout": "false",
  };
}
