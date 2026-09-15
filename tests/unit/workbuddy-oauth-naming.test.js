/**
 * WorkBuddy OAuth connections must be named after the signed-in account, not
 * "Account 1" / "Account 2".
 *
 * Root cause: `mapTokens` returned only { accessToken, refreshToken, expiresIn,
 * providerSpecificData.userId }. createProviderConnection derives an OAuth
 * row's name from `data.name`, then from `data.email`, and only falls back to
 * `Account <n>` when both are missing — so every WorkBuddy login landed on the
 * numbered placeholder even though the Keycloak access token carries
 * `preferred_username` and `email`.
 *
 * The claim set below mirrors a real workbuddy.ai Keycloak payload (same claim
 * names and realm), with synthetic identity values. mapTokens reads claims
 * without verifying the signature, so the third segment is a stub.
 */
import { describe, it, expect } from "vitest";
import workbuddy from "../../src/lib/oauth/providers/workbuddy.js";

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

function makeAccessToken(claims) {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.signature-stub`;
}

const KEYCLOAK_CLAIMS = {
  exp: 1815953383,
  iat: 1784417383,
  iss: "https://www.workbuddy.ai/auth/realms/copilot",
  sub: "11111111-2222-4333-8444-555555555555",
  email_verified: true,
  name: "Example User",
  preferred_username: "exampleuser",
  given_name: "Example",
  family_name: "User",
  email: "exampleuser@example.com",
};

describe("WorkBuddy mapTokens identity", () => {
  it("names the connection from preferred_username", () => {
    const out = workbuddy.mapTokens({
      access_token: makeAccessToken(KEYCLOAK_CLAIMS),
      refresh_token: "rt-1",
      expires_in: 86400,
    });

    expect(out.name).toBe("exampleuser");
    expect(out.displayName).toBe("exampleuser");
    // Never the numbered placeholder createProviderConnection would invent.
    expect(out.name).not.toMatch(/^Account \d+$/);
  });

  it("also records the verified email and account id", () => {
    const out = workbuddy.mapTokens({
      access_token: makeAccessToken(KEYCLOAK_CLAIMS),
      refresh_token: "rt-1",
    });

    expect(out.email).toBe("exampleuser@example.com");
    expect(out.providerSpecificData).toEqual({
      userId: "11111111-2222-4333-8444-555555555555",
    });
  });

  it("falls back to email when the realm omits preferred_username", () => {
    const { preferred_username, ...withoutUsername } = KEYCLOAK_CLAIMS;
    const out = workbuddy.mapTokens({
      access_token: makeAccessToken(withoutUsername),
      refresh_token: "rt-2",
    });

    expect(out.name).toBe("exampleuser@example.com");
  });

  it("prefers the userId reported by the token endpoint over the JWT sub", () => {
    const out = workbuddy.mapTokens({
      access_token: makeAccessToken(KEYCLOAK_CLAIMS),
      refresh_token: "rt-3",
      _userId: "explicit-user-id",
    });

    expect(out.providerSpecificData).toEqual({ userId: "explicit-user-id" });
  });

  it("still logs in on an opaque (non-JWT) token", () => {
    const out = workbuddy.mapTokens({
      access_token: "opaque-token",
      refresh_token: "rt-4",
      expires_in: 3600,
    });

    expect(out.accessToken).toBe("opaque-token");
    expect(out.expiresIn).toBe(3600);
    // No name/email invented from an unreadable token.
    expect(out.name).toBeUndefined();
    expect(out.email).toBeUndefined();
    expect(out.providerSpecificData).toEqual({});
  });
});
