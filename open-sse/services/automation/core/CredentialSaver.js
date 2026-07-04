import { createProviderConnection } from "../../../../src/lib/db/repos/connectionsRepo.js";

export async function saveCredentials(provider, creds) {
  const {
    email,
    accessToken,
    refreshToken,
    expiresIn,
    expiresAt,
    tokenType,
    scope,
    providerSpecificData,
  } = creds;

  const data = {
    provider,
    authType: "oauth",
    name: email,
    email,
    isActive: true,
    accessToken,
    refreshToken,
    expiresIn,
    expiresAt,
    tokenType,
    scope,
  };

  if (providerSpecificData && Object.keys(providerSpecificData).length > 0) {
    data.providerSpecificData = providerSpecificData;
  }

  const conn = await createProviderConnection(data);
  return { success: true, connectionId: conn.id };
}
