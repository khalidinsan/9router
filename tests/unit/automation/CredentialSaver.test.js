import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../../");
const connectionsRepoPath = join(repoRoot, "src/lib/db/repos/connectionsRepo.js");

const createProviderConnection = mock.fn(async (data) => ({ id: "conn-123", ...data }));

mock.module(connectionsRepoPath, {
  namedExports: { createProviderConnection },
});

const { saveCredentials } = await import("../../../open-sse/services/automation/core/CredentialSaver.js");

describe("CredentialSaver", () => {
  it("saves antigravity OAuth credentials with expected fields", async () => {
    const creds = {
      email: "test@example.com",
      accessToken: "access-token-abc",
      refreshToken: "refresh-token-xyz",
      expiresIn: 3600,
      expiresAt: "2026-07-04T12:00:00.000Z",
      tokenType: "Bearer",
      scope: "read write",
      providerSpecificData: { username: "testuser", chatgptAccountId: "ws-1" },
    };

    const result = await saveCredentials("antigravity", creds);

    assert.equal(result.success, true);
    assert.equal(result.connectionId, "conn-123");
    assert.equal(createProviderConnection.mock.callCount(), 1);

    const call = createProviderConnection.mock.calls[0];
    const data = call.arguments[0];
    assert.equal(data.provider, "antigravity");
    assert.equal(data.authType, "oauth");
    assert.equal(data.name, "test@example.com");
    assert.equal(data.email, "test@example.com");
    assert.equal(data.isActive, true);
    assert.equal(data.accessToken, "access-token-abc");
    assert.equal(data.refreshToken, "refresh-token-xyz");
    assert.equal(data.expiresIn, 3600);
    assert.equal(data.expiresAt, "2026-07-04T12:00:00.000Z");
    assert.equal(data.tokenType, "Bearer");
    assert.equal(data.scope, "read write");
    assert.deepEqual(data.providerSpecificData, { username: "testuser", chatgptAccountId: "ws-1" });
  });

  it("omits providerSpecificData when empty", async () => {
    createProviderConnection.mock.resetCalls();

    const creds = {
      email: "minimal@example.com",
      accessToken: "token",
    };

    await saveCredentials("antigravity", creds);

    const call = createProviderConnection.mock.calls[0];
    const data = call.arguments[0];
    assert.equal("providerSpecificData" in data, false);
  });
});
