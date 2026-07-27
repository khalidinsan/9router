import { createHash } from "node:crypto";
import {
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_USER_AGENT,
  GROK_CLI_VERSION,
} from "open-sse/config/grokCli.js";
import { getModelUpstreamId } from "open-sse/config/providerModels.js";
import {
  refreshProviderCredentials,
  shouldRefreshCredentials,
} from "open-sse/services/oauthCredentialManager.js";
import { curlFetch } from "open-sse/utils/curlFetch.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

const GROK_CLI_RESPONSES_URL = "https://cli-chat-proxy.grok.com/v1/responses";
export const GROK_CLI_PROBE_REFRESHED_CREDENTIALS = Symbol("grokCliProbeRefreshedCredentials");

function fingerprint(token) {
  return token
    ? createHash("sha256").update(String(token)).digest("hex").slice(0, 12)
    : null;
}

function proxyOptionsFrom(config = {}) {
  return {
    connectionProxyEnabled: config.connectionProxyEnabled === true,
    connectionProxyUrl: config.connectionProxyUrl || "",
    connectionNoProxy: config.connectionNoProxy || "",
    strictProxy:
      config.strictProxy === true ||
      config.connectionProxyEnabled === true ||
      Boolean(config.vercelRelayUrl),
    ...(config.vercelRelayUrl ? { vercelRelayUrl: config.vercelRelayUrl } : {}),
  };
}

function outputTextFromCompleted(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") return content.text;
    }
  }
  return "";
}

async function inspectSse(response) {
  const text = await response.text();
  let completed = false;
  let outputText = "";

  for (const block of text.split(/\r?\n\r?\n/)) {
    let eventName = "";
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") continue;

    try {
      const payload = JSON.parse(data);
      const type = payload.type || eventName;
      if (type === "response.output_text.delta" && typeof payload.delta === "string") {
        outputText += payload.delta;
      }
      if (type === "response.completed") {
        completed = true;
        outputText ||= outputTextFromCompleted(payload.response);
      }
    } catch {
      // Ignore malformed/non-JSON SSE frames and continue looking for a terminal event.
    }
  }

  return { completed, outputText };
}

function attachRefreshedCredentials(result, refreshedCredentials) {
  if (refreshedCredentials) {
    Object.defineProperty(result, GROK_CLI_PROBE_REFRESHED_CREDENTIALS, {
      value: refreshedCredentials,
      enumerable: false,
    });
  }
  return result;
}

function errorResult({ startedAt, now, status, error, token, modelId, refreshedCredentials = null }) {
  return attachRefreshedCredentials({
    ok: false,
    status,
    error: String(error || "Grok CLI probe failed"),
    latencyMs: Math.max(0, now() - startedAt),
    tokenFingerprint: fingerprint(token),
    modelId,
  }, refreshedCredentials);
}

export function createDefaultGrokCliProbeDependencies() {
  return {
    now: Date.now,
    curlFetch,
    resolveConnectionProxyConfig,
    shouldRefreshCredentials,
    refreshProviderCredentials,
  };
}

/**
 * Probe exactly one Grok CLI connection and model without account selection,
 * fallback, or persistence. Refreshed credentials only live for this request.
 */
export async function probeGrokCliConnection(connection, modelId, injected = {}) {
  const deps = { ...createDefaultGrokCliProbeDependencies(), ...injected };
  const requestedModelId = String(modelId || "").trim();
  const startedAt = deps.now();
  let working = connection ? { ...connection } : {};
  let token = working.accessToken || "";
  let refreshedCredentials = null;

  if (!requestedModelId) {
    return errorResult({ startedAt, now: deps.now, status: 0, error: "modelId is required", token, modelId: requestedModelId });
  }

  let proxyOptions;
  try {
    proxyOptions = proxyOptionsFrom(
      await deps.resolveConnectionProxyConfig(working.providerSpecificData || {})
    );

    if (
      injected.refreshCredentials !== false &&
      working.refreshToken &&
      deps.shouldRefreshCredentials("grok-cli", working)
    ) {
      const refreshed = await deps.refreshProviderCredentials(
        "grok-cli",
        working,
        console,
        proxyOptions
      );
      if (refreshed?.accessToken) {
        refreshedCredentials = refreshed;
        working = { ...working, ...refreshed };
        token = refreshed.accessToken;
      }
    }
  } catch (error) {
    return errorResult({ startedAt, now: deps.now, status: 0, error: error.message, token, modelId: requestedModelId });
  }

  if (!token) {
    return errorResult({ startedAt, now: deps.now, status: 0, error: "Grok CLI access token is required", token, modelId: requestedModelId });
  }

  const upstreamModelId = getModelUpstreamId("gcli", requestedModelId);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    "User-Agent": GROK_CLI_USER_AGENT,
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
    "x-grok-client-version": GROK_CLI_VERSION,
    "x-grok-client-mode": "headless",
  };

  try {
    const networkFetch = injected.curlFetch || injected.proxyAwareFetch || deps.curlFetch;
    const response = await networkFetch(
      GROK_CLI_RESPONSES_URL,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: upstreamModelId,
          input: "hi",
          stream: true,
          store: false,
          max_output_tokens: 16,
        }),
      },
      proxyOptions
    );

    if (!response.ok) {
      const body = await response.text();
      return errorResult({
        startedAt,
        now: deps.now,
        status: response.status,
        error: body || response.statusText || `HTTP ${response.status}`,
        token,
        modelId: requestedModelId,
        refreshedCredentials,
      });
    }

    const sse = await inspectSse(response);
    if (!sse.completed && !sse.outputText) {
      return errorResult({
        startedAt,
        now: deps.now,
        status: response.status,
        error: "Grok CLI response ended without output or response.completed",
        token,
        modelId: requestedModelId,
        refreshedCredentials,
      });
    }

    return attachRefreshedCredentials({
      ok: true,
      status: response.status,
      error: null,
      latencyMs: Math.max(0, deps.now() - startedAt),
      tokenFingerprint: fingerprint(token),
      modelId: requestedModelId,
    }, refreshedCredentials);
  } catch (error) {
    return errorResult({
      startedAt,
      now: deps.now,
      status: 0,
      error: error.message,
      token,
      modelId: requestedModelId,
      refreshedCredentials,
    });
  }
}
