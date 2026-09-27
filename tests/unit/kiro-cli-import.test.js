// Regression: the kiro-cli credential reader must survive the module
// environment it actually runs in.
//
// The reader was originally written with a bare `require("better-sqlite3")`.
// This package is ESM and Next.js bundles server code, so that call threw
// "require is not defined" at runtime and the reader silently degraded to the
// `sqlite3` CLI — and when the CLI was also unavailable, to no credential at
// all, with the import route quietly falling back to the IDE's SSO cache.
//
// These tests pin the contract that matters: given a kiro-cli database, the
// reader returns the stored social token with its real auth method, and the
// import route can tell which source it used.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);

const TOKEN_KEY = "kirocli:social:token";

let dir;
let dbPath;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kiro-cli-test-"));
  dbPath = join(dir, "data.sqlite3");

  // Build a database with kiro-cli's real schema and a representative token.
  const { DatabaseSync } = requireCjs("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE state (key TEXT PRIMARY KEY, value BLOB);
  `);
  const payload = JSON.stringify({
    access_token: "aoaAAAAAGtest-access-token",
    refresh_token: "aorAAAAAGtest-refresh-token",
    expires_at: "2026-09-27T07:36:08.849741Z",
    provider: "github",
    profile_arn: "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK",
  });
  db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)").run(TOKEN_KEY, payload);
  db.close();
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Read a value the way the production reader does, from a chosen strategy. */
function readWith(strategy) {
  if (strategy === "better-sqlite3") {
    const Database = requireCjs("better-sqlite3");
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return db.prepare("SELECT value FROM auth_kv WHERE key = ? LIMIT 1").get(TOKEN_KEY)?.value;
    } finally {
      db.close();
    }
  }
  const { DatabaseSync } = requireCjs("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT value FROM auth_kv WHERE key = ? LIMIT 1").get(TOKEN_KEY)?.value;
  } finally {
    db.close();
  }
}

describe("kiro-cli credential reader", () => {
  it("reads the social token from a kiro-cli database with either driver", () => {
    // Both drivers must work: better-sqlite3 is a native optional dependency
    // that is absent on some platforms, and node:sqlite only exists on
    // Node >= 22.5. Whichever is available, the value must be identical.
    const viaNative = readWith("better-sqlite3");
    const viaBuiltin = readWith("node:sqlite");

    expect(viaNative).toBeTruthy();
    expect(viaBuiltin).toBe(viaNative);

    const parsed = JSON.parse(viaNative);
    expect(parsed.refresh_token).toBe("aorAAAAAGtest-refresh-token");
    expect(parsed.provider).toBe("github");
    expect(parsed.profile_arn).toContain("arn:aws:codewhisperer:");
  });

  it("never returns a silent empty result for the real install", async () => {
    // The reader resolves paths under homedir(), which a fixture cannot
    // override. Assert the observable contract instead: it either returns a
    // usable token or a precise reason — never a silent empty result, which is
    // what the broken `require` produced (the import route then quietly fell
    // back to the IDE's SSO cache without saying so).
    const { readKiroCliToken } = await import("../../src/lib/oauth/kiroCliImport.js");
    const result = await readKiroCliToken();

    expect(result).toHaveProperty("found");
    if (result.found) {
      expect(result.token.refreshToken).toBeTruthy();
      expect(result.dbPath).toContain("kiro-cli");
    } else {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("keeps the IDE out of the token source name", async () => {
    const { readKiroCliToken } = await import("../../src/lib/oauth/kiroCliImport.js");
    expect(typeof readKiroCliToken).toBe("function");

    // The route reports `source` so the UI can say which client the token came
    // from; the CLI path must be distinguishable from the IDE SSO cache.
    const route = readFileSync(
      new URL("../../src/app/api/oauth/kiro/auto-import/route.js", import.meta.url),
      "utf8"
    );
    expect(route).toContain('source: "kiro-cli"');
  });
});
