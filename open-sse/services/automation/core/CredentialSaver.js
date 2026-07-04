export async function saveCredentials(provider, creds, options = {}) {
  const createConnection = options.createConnection;

  async function getDefaultCreateConnection() {
    const { createProviderConnection } = await import(
      "../../../../src/lib/db/repos/connectionsRepo.js"
    );
    return createProviderConnection;
  }

  const {
    email,
    accessToken,
    refreshToken,
    expiresIn,
    expiresAt,
    tokenType,
    scope,
    projectId,
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
    projectId,
  };

  if (providerSpecificData && Object.keys(providerSpecificData).length > 0) {
    data.providerSpecificData = providerSpecificData;
  }

  const connFn = createConnection ?? (await getDefaultCreateConnection());
  const conn = await connFn(data);
  return { success: true, connectionId: conn.id };
}
