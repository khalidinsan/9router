/**
 * Kiro (AWS CodeWhisperer) usage handler
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { resolveDefaultProfileArn } from "../../config/kiroConstants.js";
import {
  buildKiroCliUsageHeaders,
  kiroCliManagementHost,
  KIRO_CLI_ORIGIN,
} from "../../config/kiroClient.js";
import { v4 as uuidv4 } from "uuid";
import { U, parseResetTime } from "./shared.js";

/**
 * Kiro (AWS CodeWhisperer) Usage
 */
function parseKiroQuotaData(data) {
  const usageList = data.usageBreakdownList || [];
  const quotaInfo = {};
  const resetAt = parseResetTime(data.nextDateReset || data.resetDate);

  usageList.forEach((breakdown) => {
    const resourceType = breakdown.resourceType?.toLowerCase() || "unknown";
    const used = breakdown.currentUsageWithPrecision || 0;
    const total = breakdown.usageLimitWithPrecision || 0;

    quotaInfo[resourceType] = {
      used,
      total,
      remaining: total - used,
      resetAt,
      unlimited: false,
    };

    // Add free trial if available
    if (breakdown.freeTrialInfo) {
      const freeUsed = breakdown.freeTrialInfo.currentUsageWithPrecision || 0;
      const freeTotal = breakdown.freeTrialInfo.usageLimitWithPrecision || 0;

      quotaInfo[`${resourceType}_freetrial`] = {
        used: freeUsed,
        total: freeTotal,
        remaining: freeTotal - freeUsed,
        resetAt: parseResetTime(breakdown.freeTrialInfo.freeTrialExpiry || resetAt),
        unlimited: false,
      };
    }
  });

  return {
    plan: data.subscriptionInfo?.subscriptionTitle || "Kiro",
    quotas: quotaInfo,
  };
}

export async function getKiroUsage(accessToken, providerSpecificData, proxyOptions = null) {
  const authMethod = providerSpecificData?.authMethod || "builder-id";
  // API-key Kiro connections authenticate the quota API the same way the chat
  // executor does: a bearer token plus a `tokentype: API_KEY` header so
  // CodeWhisperer treats it as a long-lived API key rather than an OIDC token.
  // Without this header the GetUsageLimits call is rejected (401/403).
  const isApiKey = authMethod === "api_key";
  const isExternalIdp = authMethod === "external_idp";
  const apiKeyHeaders = isApiKey ? { tokentype: "API_KEY" } : {};
  const externalIdpHeaders = isExternalIdp ? { TokenType: "EXTERNAL_IDP" } : {};

  // For api-key auth, never inject the shared default placeholder profileArn —
  // CodeWhisperer 403s a request whose profileArn isn't owned by the key's
  // account. Only send a profileArn actually resolved for this connection.
  const profileArn = isApiKey
    ? (providerSpecificData?.profileArn || "")
    : (providerSpecificData?.profileArn || resolveDefaultProfileArn(authMethod));

  const getUsageParams = new URLSearchParams({
    isEmailRequired: "true",
    origin: KIRO_CLI_ORIGIN,
    resourceType: "AGENTIC_REQUEST",
  });

  // kiro-cli reaches GetUsageLimits through the control plane at
  // management.*.kiro.dev with an x-amz-target header, not through the
  // IDE's q.*.amazonaws.com surfaces. Try the CLI surface first, then fall
  // back to the IDE-era endpoints for accounts/regions where it is not
  // available.
  const attempts = [
    {
      name: "management-getusagelimits",
      run: async () => {
        const params = new URLSearchParams({
          origin: KIRO_CLI_ORIGIN,
          ...(profileArn ? { profileArn } : {}),
        });
        const region = providerSpecificData?.region || "us-east-1";
        return proxyAwareFetch(`${kiroCliManagementHost(region)}/?${params}`, {
          method: "POST",
          headers: {
            ...buildKiroCliUsageHeaders(),
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/x-amz-json-1.0",
            "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits",
            "amz-sdk-request": "attempt=1; max=3",
            "amz-sdk-invocation-id": uuidv4(),
            ...apiKeyHeaders,
            ...externalIdpHeaders,
          },
          body: JSON.stringify({
            origin: KIRO_CLI_ORIGIN,
            ...(profileArn ? { profileArn } : {}),
          }),
        }, proxyOptions);
      },
    },
    {
      name: "codewhisperer-get",
      run: async () => proxyAwareFetch(
        `${U("kiro").cwHost}${U("kiro").limitsPath}?${getUsageParams.toString()}`,
        {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Accept": "application/json",
            ...buildKiroCliUsageHeaders(),
            ...apiKeyHeaders,
            ...externalIdpHeaders,
          },
        },
        proxyOptions
      ),
    },
    {
      name: "codewhisperer-post",
      run: async () => proxyAwareFetch(U("kiro").cwHost, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/x-amz-json-1.0",
          "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits",
          "Accept": "application/json",
          ...buildKiroCliUsageHeaders(),
          ...apiKeyHeaders,
          ...externalIdpHeaders,
        },
        body: JSON.stringify({
          origin: KIRO_CLI_ORIGIN,
          ...(profileArn ? { profileArn } : {}),
          resourceType: "AGENTIC_REQUEST",
        }),
      }, proxyOptions),
    },
    {
      name: "q-get",
      run: async () => {
        const params = new URLSearchParams({
          origin: KIRO_CLI_ORIGIN,
          ...(profileArn ? { profileArn } : {}),
          resourceType: "AGENTIC_REQUEST",
        });
        return proxyAwareFetch(`${U("kiro").qHost}${U("kiro").limitsPath}?${params}`, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Accept": "application/json",
            ...buildKiroCliUsageHeaders(),
            ...apiKeyHeaders,
            ...externalIdpHeaders,
          },
        }, proxyOptions);
      },
    },
  ];

  let sawAuthError = false;
  const errors = [];

  for (const attempt of attempts) {
    try {
      const response = await attempt.run();
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        if (response.status === 401 || response.status === 403) {
          sawAuthError = true;
        }
        errors.push(`${attempt.name}:${response.status}${errorText ? `:${errorText}` : ""}`);
        continue;
      }

      const data = await response.json();
      return parseKiroQuotaData(data);
    } catch (error) {
      errors.push(`${attempt.name}:${error.message}`);
    }
  }

  if (sawAuthError && authMethod === "idc") {
    return {
      message: "Kiro quota API is unavailable for the current AWS IAM Identity Center session. Chat may still work. If this persists after renewing your session, reconnect Kiro.",
      quotas: {},
    };
  }

  // Social auth (Google/GitHub) - these use a different token format that may not work with AWS CodeWhisperer quota APIs
  if (sawAuthError && (authMethod === "google" || authMethod === "github")) {
    return {
      message: "Kiro quota API authentication expired. Chat may still work.",
      quotas: {},
    };
  }

  if (sawAuthError) {
    return {
      message: "Kiro quota API rejected the current token. Chat may still work.",
      quotas: {},
    };
  }

  const fallbackMessage =
    errors.length > 0
      ? `Unable to fetch Kiro usage right now. (${errors[errors.length - 1]})`
      : "Unable to fetch Kiro usage right now.";

  return {
    message: fallbackMessage,
    quotas: {},
  };
}
