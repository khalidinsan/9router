// Pure, process-local safety policy for Grok CLI account fallback.

import { parseGrokCliFreeUsageTokens } from "./accountFallback.js";

export const GROK_CLI_MAX_ACCOUNT_ATTEMPTS = 3;
export const GROK_CLI_MAX_EXHAUSTED_ACCOUNT_SKIPS = 20;
// Backward-compatible export for callers/tests written before the invariant was named precisely.
export const GROK_CLI_MAX_FALLBACK_ACCOUNTS = GROK_CLI_MAX_ACCOUNT_ATTEMPTS;
export const GROK_CLI_402_CIRCUIT_THRESHOLD = 3;
export const GROK_CLI_402_CIRCUIT_WINDOW_MS = 60_000;
export const GROK_CLI_402_CIRCUIT_OPEN_MS = 5 * 60_000;

const STATE_KEY = Symbol.for("9router.grokCliSafety.state.v1");

function createState() {
  return { observations: new Map(), openUntil: 0, openSignature: null };
}

function state() {
  if (!globalThis[STATE_KEY]) globalThis[STATE_KEY] = createState();
  return globalThis[STATE_KEY];
}

function timestamp(now) {
  if (now instanceof Date) return now.getTime();
  const value = Number(now ?? Date.now());
  return Number.isFinite(value) ? value : Date.now();
}

function textOf(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value ?? ""); }
}

/** Normalize known Grok quota responses to stable canonical classes. */
export function normalizeGrokCli402Signature(error) {
  const raw = textOf(error);
  try {
    const parsed = typeof error === "string" ? JSON.parse(error) : error;
    const code = String(parsed?.code || parsed?.error?.code || "").toLowerCase();
    if (code.includes("free-usage-exhausted")) return "";
    if (code.includes("spending-limit")) return "spending-limit";
  } catch {
    // Fall through to text classification.
  }
  const lower = raw.toLowerCase();
  if (lower.includes("free-usage-exhausted") || lower.includes("free usage exhausted")) {
    return "";
  }
  if (
    lower.includes("personal-team-blocked:spending-limit") ||
    lower.includes("run out of credits") ||
    lower.includes("spending limit") ||
    lower.includes("spending-limit")
  ) {
    return "spending-limit";
  }
  return "";
}

function circuitReport(now) {
  const current = timestamp(now);
  const s = state();
  if (s.openUntil <= current) {
    s.openUntil = 0;
    s.openSignature = null;
  }
  return {
    isOpen: s.openUntil > current,
    openUntil: s.openUntil ? new Date(s.openUntil).toISOString() : null,
    signature: s.openSignature,
  };
}

/** Record a 402 observed for one connection and return the resulting circuit state. */
export function recordGrokCli402(connectionId, error, now = Date.now()) {
  const current = timestamp(now);
  const signature = normalizeGrokCli402Signature(error);
  const s = state();
  const cutoff = current - GROK_CLI_402_CIRCUIT_WINDOW_MS;

  for (const [key, observations] of s.observations) {
    for (const [id, seenAt] of observations) if (seenAt < cutoff) observations.delete(id);
    if (!observations.size) s.observations.delete(key);
  }

  if (signature && connectionId != null) {
    const observations = s.observations.get(signature) || new Map();
    observations.set(String(connectionId), current);
    s.observations.set(signature, observations);
    if (observations.size >= GROK_CLI_402_CIRCUIT_THRESHOLD) {
      s.openUntil = Math.max(s.openUntil, current + GROK_CLI_402_CIRCUIT_OPEN_MS);
      s.openSignature = signature;
    }
  }
  return circuitReport(current);
}

export function checkGrokCli402Circuit(now = Date.now()) {
  return circuitReport(now);
}

export function isGrokCliHardBlocked(conn) {
  const psd = conn?.providerSpecificData || {};
  return psd.reauthRequired === true || psd.quotaExhausted === true ||
    ["quota_exhausted", "permission_denied", "reauth_required"].includes(conn?.testStatus);
}

function cleanProviderData(conn, extra = {}) {
  const current = conn?.providerSpecificData || {};
  return {
    ...current,
    quotaExhausted: false,
    quotaExhaustedAt: null,
    quotaSuspectedAt: null,
    quotaObservationCount: 0,
    quotaConfirmationCount: 0,
    quotaConfirmationAt: null,
    quotaConfirmationTokenFingerprint: null,
    quotaConfirmationModel: null,
    freeTokensActual: null,
    permissionDenied: false,
    permissionDeniedAt: null,
    ...extra,
    reauthRequired: current.reauthRequired,
  };
}

export function buildGrokCliSuccessUpdate(conn, now = new Date()) {
  return {
    testStatus: "active",
    lastErrorType: null,
    errorCode: null,
    lastError: null,
    lastErrorAt: null,
    providerSpecificData: {
      ...(conn?.providerSpecificData || {}),
      quotaSuspectedAt: null,
      quotaObservationCount: 0,
      lastSuccessAt: now.toISOString(),
    },
  };
}

export function buildGrokCliManualEnableUpdate(conn, now = new Date()) {
  return {
    isActive: true,
    testStatus: "active",
    lastErrorType: null,
    errorCode: null,
    lastError: null,
    lastErrorAt: null,
    quotaExhaustedAt: null,
    providerSpecificData: cleanProviderData(conn, { manuallyEnabledAt: now.toISOString() }),
  };
}

export function buildGrokCliSuspectedQuotaUpdate(conn, now = new Date()) {
  const count = Number(conn?.providerSpecificData?.quotaObservationCount) || 0;
  return {
    // Keep canonical routing state unchanged until an isolated probe confirms.
    testStatus: conn?.testStatus || "active",
    lastErrorType: "suspected_quota",
    errorCode: 402,
    lastErrorAt: now.toISOString(),
    providerSpecificData: {
      ...(conn?.providerSpecificData || {}),
      quotaSuspectedAt: now.toISOString(),
      quotaObservationCount: count + 1,
      quotaConfirmationCount: Number(conn?.providerSpecificData?.quotaConfirmationCount) || 0,
    },
  };
}

export function buildGrokCliAuthoritativeQuotaExhaustedUpdate(conn, status = 429, error = null, now = new Date()) {
  const tokens = parseGrokCliFreeUsageTokens(error);
  return {
    isActive: false,
    testStatus: "quota_exhausted",
    lastErrorType: "quota_exhausted",
    errorCode: Number(status) || 429,
    lastError: error ? textOf(error).slice(0, 240) : "Grok free usage exhausted",
    lastErrorAt: now.toISOString(),
    quotaExhaustedAt: now.toISOString(),
    providerSpecificData: {
      ...(conn?.providerSpecificData || {}),
      quotaExhausted: true,
      quotaExhaustedAt: now.toISOString(),
      quotaErrorCode: "subscription:free-usage-exhausted",
      ...(tokens.actual != null ? { freeTokensActual: tokens.actual } : {}),
      ...(tokens.limit != null ? { freeTokenLimit: tokens.limit } : {}),
      lastQuotaCheckAt: now.toISOString(),
      quotaConfirmationCount: 0,
      quotaConfirmationAt: null,
      quotaConfirmationTokenFingerprint: null,
      quotaConfirmationModel: null,
    },
  };
}

export function buildGrokCliConfirmedQuotaUpdate(conn, now = new Date(), context = {}) {
  const psd = conn?.providerSpecificData || {};
  const sameFingerprint = Boolean(context.tokenFingerprint) &&
    psd.quotaConfirmationTokenFingerprint === context.tokenFingerprint;
  const sameModel = Boolean(context.modelId) && psd.quotaConfirmationModel === context.modelId;
  const lastAt = new Date(psd.quotaConfirmationAt || 0).getTime();
  const recent = Number.isFinite(lastAt) && now.getTime() - lastAt <= 15 * 60_000;
  const previousCount = sameFingerprint && sameModel && recent
    ? Number(psd.quotaConfirmationCount) || 0
    : 0;
  const count = previousCount + 1;
  const confirmed = count >= 2;
  return {
    ...(confirmed ? { isActive: false } : {}),
    testStatus: confirmed ? "quota_exhausted" : "suspected_quota",
    lastErrorType: confirmed ? "quota_exhausted" : "suspected_quota",
    errorCode: 402,
    lastErrorAt: now.toISOString(),
    ...(confirmed ? { quotaExhaustedAt: now.toISOString() } : {}),
    providerSpecificData: {
      ...(conn?.providerSpecificData || {}),
      quotaConfirmationCount: count,
      quotaConfirmationAt: now.toISOString(),
      quotaConfirmationTokenFingerprint: context.tokenFingerprint || null,
      quotaConfirmationModel: context.modelId || null,
      quotaSuspectedAt: conn?.providerSpecificData?.quotaSuspectedAt || now.toISOString(),
      quotaExhausted: confirmed,
      ...(confirmed ? { quotaExhaustedAt: now.toISOString() } : {}),
    },
  };
}

export function resetGrokCliSafetyStateForTests() {
  globalThis[STATE_KEY] = createState();
}

export const __resetGrokCliSafetyForTests = resetGrokCliSafetyStateForTests;
