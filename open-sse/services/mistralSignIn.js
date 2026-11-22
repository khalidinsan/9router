/**
 * Mistral Vibe browser sign-in.
 *
 * Mirrors the flow the Vibe CLI runs (vibe/setup/auth/http_browser_sign_in_gateway.py):
 *
 *   1. POST {api}/vibe/sign-in {code_challenge, code_challenge_method:"S256"}
 *      → {process_id, sign_in_url, poll_url, expires_at}
 *   2. the user signs in at sign_in_url in their own browser
 *   3. GET poll_url → {status, exchange_token}
 *   4. POST {api}/vibe/sign-in/{process_id}/exchange {exchange_token, code_verifier}
 *      → {api_key}
 *
 * The key it mints is a *Vibe* key: its usage is metered against the plan's
 * Vibe Code allowance, not the Studio API allowance. That is the whole point of
 * this flow — a Studio key is a different quota bucket, not a different API.
 */
import crypto from "crypto";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

export const MISTRAL_SIGN_IN_API_BASE =
  process.env.MISTRAL_SIGN_IN_API_BASE || "https://console.mistral.ai/api";

// The server expires an attempt after ~15 minutes; drop our copy at the same time.
const SESSION_TTL_MS = 15 * 60 * 1000;

/** @type {Map<string, {verifier: string, pollUrl: string, expiresAt: number}>} */
const sessions = new Map();

function pruneExpired() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
}

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function startMistralSignIn({ proxyOptions = null } = {}) {
  pruneExpired();
  const { verifier, challenge } = pkcePair();

  const res = await proxyAwareFetch(
    `${MISTRAL_SIGN_IN_API_BASE}/vibe/sign-in`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ code_challenge: challenge, code_challenge_method: "S256" }),
    },
    proxyOptions,
  );

  if (!res.ok) throw new Error(`Mistral sign-in could not start (${res.status})`);

  const data = await res.json().catch(() => null);
  if (!data?.process_id || !data?.sign_in_url || !data?.poll_url) {
    throw new Error("Mistral sign-in returned an unexpected payload");
  }

  sessions.set(data.process_id, {
    verifier,
    pollUrl: data.poll_url,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });

  return {
    processId: data.process_id,
    signInUrl: data.sign_in_url,
    expiresAt: data.expires_at || null,
  };
}

/**
 * Poll one attempt. Resolves to {status:"pending"} until the browser finishes,
 * then exchanges the one-time token for an API key.
 */
export async function pollMistralSignIn(processId, { proxyOptions = null } = {}) {
  const session = sessions.get(processId);
  if (!session) return { status: "unknown" };
  if (session.expiresAt <= Date.now()) {
    sessions.delete(processId);
    return { status: "expired" };
  }

  const pollRes = await proxyAwareFetch(
    session.pollUrl,
    { method: "GET", headers: { Accept: "application/json" } },
    proxyOptions,
  );

  if (pollRes.status === 410) {
    sessions.delete(processId);
    return { status: "expired" };
  }
  if (!pollRes.ok) {
    return { status: "error", message: `Mistral sign-in poll failed (${pollRes.status})` };
  }

  const pollBody = await pollRes.json().catch(() => null);
  const status = pollBody?.status;
  if (status === "pending") return { status: "pending" };
  if (status !== "completed") {
    sessions.delete(processId);
    return { status: status || "error", message: pollBody?.message || null };
  }

  const exchangeRes = await proxyAwareFetch(
    `${MISTRAL_SIGN_IN_API_BASE}/vibe/sign-in/${processId}/exchange`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        exchange_token: pollBody.exchange_token,
        code_verifier: session.verifier,
      }),
    },
    proxyOptions,
  );

  sessions.delete(processId);

  if (!exchangeRes.ok) {
    const detail = await exchangeRes.json().catch(() => null);
    // 9004: the selected workspace may not mint Vibe keys (shared/enterprise seat).
    if (exchangeRes.status === 403 && detail?.code === 9004) {
      return {
        status: "denied",
        message:
          "This workspace can't be used for Mistral Vibe. Sign in again and pick another workspace.",
      };
    }
    return { status: "error", message: `Mistral sign-in exchange failed (${exchangeRes.status})` };
  }

  const payload = await exchangeRes.json().catch(() => null);
  if (!payload?.api_key) {
    return { status: "error", message: "Mistral sign-in did not return an API key" };
  }
  return { status: "completed", apiKey: payload.api_key };
}

/** Plan metadata for the freshly minted key; used for the connection label only. */
export async function fetchMistralAccount(apiKey, { proxyOptions = null } = {}) {
  if (!apiKey) return null;
  const res = await proxyAwareFetch(
    `${MISTRAL_SIGN_IN_API_BASE}/vibe/whoami`,
    { method: "GET", headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
    proxyOptions,
  );
  if (!res.ok) return null;
  return res.json().catch(() => null);
}
