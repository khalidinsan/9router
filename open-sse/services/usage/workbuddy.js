/**
 * WorkBuddy AI usage handler.
 *
 * WorkBuddy bills through the same Tencent meter endpoint shape as CodeBuddy
 * (POST, payload wrapped twice under data.Response.Data), so this reuses the
 * family parser rather than duplicating it. Scoped to the "workbuddy" provider
 * so its own endpoint and headers drive the request.
 */

import { getCodeBuddyUsage } from "./codebuddy-cn.js";

const PROVIDER_ID = "workbuddy";

export async function getWorkBuddyUsage(accessToken, apiKey, providerSpecificData, proxyOptions = null) {
  return getCodeBuddyUsage(PROVIDER_ID, accessToken, apiKey, providerSpecificData, proxyOptions);
}
