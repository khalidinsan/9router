/**
 * Grok CLI account-quality probe.
 *
 * Degraded grok-cli accounts answer `print 407` with "202" — deterministically,
 * on every attempt. Verified 2026-09-13 across 108 farmed accounts at
 * effort=xhigh:
 *
 *   407 -> 407   11 accounts   (always emit a reasoning output item)
 *   407 -> 202   93 accounts   (never emit a reasoning item)
 *
 * The split is stable per account across repeated trials, so a wrong digit is a
 * real defect rather than sampling noise. Nearby numbers (406/408/500) and
 * arithmetic (17*23 -> 391) answer correctly on both cohorts, and nothing on the
 * backend distinguishes them — /v1/user, /v1/billing, /v1/models, /v1/settings
 * and 25 other endpoints are byte-identical, JWT claims match in shape, and
 * system_fingerprint is identical. This probe is the only discriminator.
 *
 * Distinct from probeGrokCliConnection(), which checks reachability with a
 * minimal "hi" turn. That probe cannot detect degradation: a degraded account
 * answers 200 normally.
 */

import { createHash } from "node:crypto";
import { grokCliChatHeaders } from "open-sse/config/grokCli.js";
import { curlFetch } from "open-sse/utils/curlFetch.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

export const GROK_CLI_QUALITY_PROBE_NUMBER = "407";
export const GROK_CLI_QUALITY_PROBE_MODEL = "grok-4.6";
export const GROK_CLI_QUALITY_PROBE_EFFORT = "xhigh";
export const GROK_CLI_QUALITY_PROBE_PROMPT = `print ${GROK_CLI_QUALITY_PROBE_NUMBER}`;
// testStatus / PSD marker for accounts that are reachable but answer the probe
// with the wrong digits. Recognised by isGrokCliHardBlocked so the account is
// skipped in rotation and is NOT silently re-enabled by the reachability reprobe.
export const GROK_CLI_DEGRADED_STATUS = "degraded_account";

const PROBE_TIMEOUT_MS = 60 * 1000;

function fingerprint(token) {
  return token
    ? createHash("sha256").update(String(token)).digest("hex").slice(0, 12)
    : null;
}

// Take the FIRST integer in the reply rather than squashing every digit
// together. Healthy accounts sometimes leak a trailing system-prompt fragment
// ("407\n\\confidence{100}"); concatenating all digits yields "407100", which
// would wrongly classify a good account as degraded.
function firstIntOf(text) {
  const match = String(text || "").match(/\d+/);
  return match ? match[0] : "";
}

async function readSseText(response) {
  const text = await response.text();
  let outputText = "";
  let completed = false;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const payload = JSON.parse(data);
      if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") {
        outputText += payload.delta;
      } else if (payload.type === "response.completed") {
        completed = true;
      }
    } catch {
      // Ignore malformed frames; a readable digit run still classifies.
    }
  }

  return { outputText, completed };
}

/**
 * Probe one connection for the 407 degradation.
 *
 * Never throws and never persists. `wrong: true` means upstream answered HTTP
 * 200 with real digits that were not the requested number — the only state that
 * indicates a definitively degraded account. Transport failures, non-200
 * responses and empty output leave `wrong` false so callers never treat an
 * unreachable account as degraded.
 *
 * @returns {Promise<{ok: boolean, wrong: boolean, status: number, digits: string,
 *   outputText: string, error: string|null, latencyMs: number, tokenFingerprint: string|null}>}
 */
export async function probeGrokCliAccountQuality(connection, injected = {}) {
  const now = injected.now || Date.now;
  const startedAt = now();
  const token = connection?.accessToken || "";

  const result = (fields) => ({
    ok: false,
    wrong: false,
    status: 0,
    digits: "",
    outputText: "",
    error: null,
    latencyMs: Math.max(0, now() - startedAt),
    tokenFingerprint: fingerprint(token),
    ...fields,
  });

  if (!token) return result({ error: "Grok CLI access token is required" });

  let proxyOptions = {};
  try {
    const resolveProxy = injected.resolveConnectionProxyConfig || resolveConnectionProxyConfig;
    proxyOptions = await resolveProxy(connection?.providerSpecificData || {});
  } catch {
    // Fall through with no proxy override rather than failing the probe.
  }

  const networkFetch = injected.curlFetch || curlFetch;
  const modelId = injected.modelId || GROK_CLI_QUALITY_PROBE_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), injected.timeoutMs || PROBE_TIMEOUT_MS);

  try {
    const response = await networkFetch(
      "https://cli-chat-proxy.grok.com/v1/responses",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          ...grokCliChatHeaders(),
        },
        body: JSON.stringify({
          model: modelId,
          input: GROK_CLI_QUALITY_PROBE_PROMPT,
          stream: true,
          store: false,
          reasoning: { summary: "concise", effort: GROK_CLI_QUALITY_PROBE_EFFORT },
        }),
      },
      proxyOptions
    );

    if (!response.ok) {
      return result({ status: response.status, error: `HTTP ${response.status}` });
    }

    const { outputText } = await readSseText(response);
    const digits = firstIntOf(outputText);

    return result({
      ok: digits === GROK_CLI_QUALITY_PROBE_NUMBER,
      // Only real digits that are simply wrong mark an account degraded.
      wrong: digits.length > 0 && digits !== GROK_CLI_QUALITY_PROBE_NUMBER,
      status: response.status,
      digits,
      outputText: outputText.slice(0, 80),
      error: digits.length === 0 ? "Probe response contained no digits" : null,
    });
  } catch (error) {
    return result({ error: error?.name === "AbortError" ? "Probe timed out" : error.message });
  } finally {
    clearTimeout(timer);
  }
}
