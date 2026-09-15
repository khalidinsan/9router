/**
 * CodeBuddy CN usage handler
 *
 * Scoped to the "codebuddy-cn" provider specifically — a future "codebuddy-intl"
 * variant would get its own handler/endpoint, so keep this CN-only.
 *
 * Quota lives behind a Tencent billing endpoint (POST, payload wrapped twice
 * under data.Response.Data). It mixes two credit types that must NOT be merged:
 *
 *  - Refill / base ("基础体验包"): a recurring allowance whose cycle resets long
 *    before the resource itself expires (CycleEndTime << DeductionEndTime). The
 *    live numbers live in the *Cycle* fields (e.g. CycleCapacityUsed 6.54 / 500)
 *    and resetAt is the next monthly refresh.
 *  - Bonus ("活动赠送包"): one-shot credits that run a single cycle and then
 *    expire for good (CycleEndTime == DeductionEndTime). Numbers live in the
 *    plain Capacity fields.
 *
 * We surface one quota row per package — a cadence label (Monthly/Weekly/Daily)
 * for refill packs, "Bonus Pack N" for bonus packs (soonest-expiring first).
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { PROVIDERS } from "../../providers/index.js";
import { U, parseResetTime } from "./shared.js";

const PROVIDER_ID = "codebuddy-cn";

// Prefer the *Precise string fields (exact), fall back to the numeric ones.
function num(precise, plain) {
  const n = Number(precise ?? plain);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse Tencent's `YYYY-MM-DD HH:mm:ss` timestamps.
 *
 * These are wall-clock in the upstream's timezone (UTC+8), with no offset in
 * the string. `new Date(str)` therefore reads them in the *server's* zone —
 * on a WIB host that lands 1 hour off, and on a UTC host 8 hours off. Verified
 * against the paired epoch fields: `CycleEndTime "2026-09-21 18:28:41"` is
 * exactly `DeductionEndTime 1789986521000` = 2026-09-21T10:28:41Z, i.e. UTC+8.
 *
 * Pinning the offset keeps reset times correct regardless of where the server
 * runs. Anything that already carries an offset, or is an epoch, is passed
 * through to the shared parser untouched.
 */
const UPSTREAM_UTC_OFFSET = "+08:00";
function parseTencentTime(value) {
  if (typeof value !== "string") return parseResetTime(value);
  const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
  if (!m) return parseResetTime(value);
  return parseResetTime(`${m[1]}T${m[2]}${UPSTREAM_UTC_OFFSET}`);
}

// Label a refill pack by its cycle length (Monthly is the common CodeBuddy case).
function refillCadence(acc) {
  const start = parseTencentTime(acc.CycleStartTime);
  const end = parseTencentTime(acc.CycleEndTime);
  if (start && end) {
    const days = (new Date(end).getTime() - new Date(start).getTime()) / 86400000;
    if (days <= 1.5) return "Daily";
    if (days <= 10) return "Weekly";
  }
  return "Monthly";
}

export async function getCodeBuddyUsage(providerId, accessToken, apiKey, providerSpecificData, proxyOptions = null) {
  const token = accessToken || apiKey;
  if (!token) {
    return { message: `CodeBuddy (${providerId}) credential not available.` };
  }

  try {
    const response = await proxyAwareFetch(U(providerId).url, {
      method: "POST",
      headers: {
        ...(PROVIDERS[providerId]?.headers || {}),
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
    }, proxyOptions);

    if (response.status === 401 || response.status === 403) {
      return { message: "CodeBuddy CN credential invalid or expired." };
    }
    if (!response.ok) {
      return { message: `CodeBuddy CN quota API error (${response.status}).` };
    }

    const json = await response.json();
    if (json?.code !== 0) {
      return { message: `CodeBuddy CN quota error: ${json?.msg || "unknown"}` };
    }

    const data = json?.data?.Response?.Data || {};
    const accounts = Array.isArray(data.Accounts) ? data.Accounts : [];
    if (accounts.length === 0) {
      return { message: "CodeBuddy CN connected. No credit package found." };
    }

    const cycleEndMs = (acc) => {
      const r = parseTencentTime(acc.CycleEndTime);
      return r ? new Date(r).getTime() : Number.POSITIVE_INFINITY;
    };

    /**
     * Is this a recurring subscription, or a one-shot bonus grant?
     *
     * The previous test compared DeductionEndTime against CycleEndTime and
     * called anything with a <2-day gap a bonus pack. That heuristic does not
     * hold: a "Pro Plan Trial Subscription" reports a 0-day gap, exactly like a
     * bonus pack, so every subscription was misclassified as a bonus — and
     * bonus rows read the plain Capacity fields, which are 0, instead of the
     * Cycle fields that carry the real number. Result: 0/500 shown where the
     * upstream reported 0.54/500.
     *
     * Two upstream signals identify the type directly, and both agree on every
     * package observed (10/10):
     *   - SubProductCode ends with `_bonus_pack`
     *   - CapacityType is 1 for bonus, 4 for subscriptions
     * Prefer SubProductCode; fall back to CapacityType; only then to the old
     * timing heuristic, so an unfamiliar package still classifies sensibly.
     */
    const isRefill = (acc) => {
      const sub = String(acc.SubProductCode || "");
      if (sub) return !/_bonus_pack/i.test(sub);
      if (acc.CapacityType !== undefined && acc.CapacityType !== null) {
        return Number(acc.CapacityType) !== 1;
      }
      const ce = cycleEndMs(acc);
      const de = Number(acc.DeductionEndTime);
      return Number.isFinite(ce) && Number.isFinite(de) && de - ce > 2 * 24 * 60 * 60 * 1000;
    };
    const byExpiry = (a, b) => cycleEndMs(a) - cycleEndMs(b);

    const refills = accounts.filter(isRefill).sort(byExpiry);
    const bonuses = accounts.filter((a) => !isRefill(a)).sort(byExpiry);

    const quotas = {};
    // Refill packs first: cadence-labelled, using the *Cycle* balance and
    // resetting at the next refresh.
    const seenRefill = {};
    refills.forEach((acc) => {
      const base = refillCadence(acc);
      seenRefill[base] = (seenRefill[base] || 0) + 1;
      const name = seenRefill[base] > 1 ? `${base} ${seenRefill[base]}` : base;
      quotas[name] = {
        used: num(acc.CycleCapacityUsedPrecise, acc.CycleCapacityUsed),
        total: num(acc.CycleCapacitySizePrecise, acc.CycleCapacitySize),
        resetAt: parseTencentTime(acc.CycleEndTime),
        unlimited: false,
        // Recurring allowance: the CycleEndTime is the next refresh, not the
        // final expiry. The UI must show "Resets in", not "Expires in".
        recurring: true,
      };
    });
    // Bonus packs: use the lifetime Capacity balance; resetAt is the expiry.
    // These are one-shot credits (CycleEndTime == DeductionEndTime), so they
    // never replenish — mark recurring:false so the UI shows "Expires in"
    // instead of implying a monthly refill.
    bonuses.forEach((acc, i) => {
      quotas[`Bonus Pack ${i + 1}`] = {
        used: num(acc.CapacityUsedPrecise, acc.CapacityUsed),
        total: num(acc.CapacitySizePrecise, acc.CapacitySize),
        resetAt: parseTencentTime(acc.CycleEndTime),
        unlimited: false,
        recurring: false,
      };
    });

    const basePkg = refills[0] || accounts[0] || {};
    const plan = basePkg.PackageName || basePkg.SubProductName || "CodeBuddy";

    return { plan, quotas };
  } catch (error) {
    return { message: `CodeBuddy (${providerId}) error: ${error.message}` };
  }
}

export async function getCodeBuddyCnUsage(accessToken, apiKey, providerSpecificData, proxyOptions = null) {
  return getCodeBuddyUsage(PROVIDER_ID, accessToken, apiKey, providerSpecificData, proxyOptions);
}

export async function getCodeBuddyIntlUsage(accessToken, apiKey, providerSpecificData, proxyOptions = null) {
  return getCodeBuddyUsage("codebuddy-intl", accessToken, apiKey, providerSpecificData, proxyOptions);
}
