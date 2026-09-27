/**
 * Read Kiro credentials from a local `kiro-cli` installation.
 *
 * kiro-cli stores its social token in a SQLite database under its app-support
 * directory, in the `auth_kv` table:
 *
 *   key   = "kirocli:social:token"
 *   value = JSON { access_token, refresh_token, expires_at, provider, profile_arn }
 *
 * The desktop IDE keeps its credentials elsewhere (macOS Keychain, "Kiro Safe
 * Storage"), so importing from this store is what makes a 9router connection
 * carry a genuine CLI-issued session rather than a re-derived one.
 *
 * The database is opened read-only and by path, never attached to the app's own
 * connection pool — kiro-cli may be running and holding a write lock.
 */

import { access, constants } from "fs/promises";
import { homedir, platform } from "os";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const TOKEN_KEY = "kirocli:social:token";

/** Candidate `data.sqlite3` paths, most-specific first. */
export function kiroCliDbPaths() {
  const home = homedir();
  const os = platform();

  if (os === "darwin") {
    return [
      join(home, "Library/Application Support/kiro-cli/data.sqlite3"),
    ];
  }
  if (os === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return [
      join(localAppData, "kiro-cli/data.sqlite3"),
      join(appData, "kiro-cli/data.sqlite3"),
    ];
  }
  // Linux / other: kiro-cli follows the XDG data dir.
  const xdg = process.env.XDG_DATA_HOME || join(home, ".local/share");
  return [
    join(xdg, "kiro-cli/data.sqlite3"),
    join(home, ".kiro-cli/data.sqlite3"),
  ];
}

async function firstExistingPath(paths) {
  for (const p of paths) {
    try {
      await access(p, constants.R_OK);
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Parse the stored token blob into the shape the import route consumes.
 * kiro-cli stores camelCase-free snake_case keys; `provider` is the social
 * provider ("github"/"google").
 */
function parseTokenBlob(raw) {
  if (!raw) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const accessToken = data.access_token || null;
  const refreshToken = data.refresh_token || null;
  if (!refreshToken) return null;

  const authMethod = data.provider === "google" || data.provider === "github"
    ? data.provider
    : data.provider || "imported";

  return {
    accessToken,
    refreshToken,
    expiresAt: data.expires_at || null,
    profileArn: data.profile_arn || null,
    authMethod,
    provider: data.provider || null,
  };
}

/**
 * Read via better-sqlite3. Preferred: no external binary, and read-only.
 *
 * `import()` rather than `require()`: this module is ESM and Next.js bundles
 * server code, so a CJS require would be rewritten at build time and throw
 * "require is not defined" at runtime — which silently degraded the reader to
 * the `sqlite3` CLI. A dynamic import keeps the native-module probe intact in
 * both the dev server and the standalone build.
 */
async function readViaBetterSqlite(dbPath) {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare("SELECT value FROM auth_kv WHERE key = ? LIMIT 1")
      .get(TOKEN_KEY);
    return row?.value || null;
  } finally {
    db.close();
  }
}

/** Read via node:sqlite (Node >= 22.5). No native build, no external binary. */
async function readViaNodeSqlite(dbPath) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT value FROM auth_kv WHERE key = ? LIMIT 1")
      .get(TOKEN_KEY);
    return row?.value || null;
  } finally {
    db.close();
  }
}

/** Read via the `sqlite3` CLI. Fallback when native bindings are unavailable. */
async function readViaSqliteCli(dbPath) {
  const { stdout } = await execFileAsync(
    "sqlite3",
    [dbPath, `SELECT value FROM auth_kv WHERE key='${TOKEN_KEY}' LIMIT 1`],
    { timeout: 10000 }
  );
  return stdout.trim() || null;
}

/**
 * Load the local kiro-cli credential.
 *
 * @returns {Promise<{ found: boolean, dbPath?: string, error?: string,
 *   token?: { accessToken, refreshToken, expiresAt, profileArn, authMethod, provider } }>}
 */
export async function readKiroCliToken() {
  const dbPath = await firstExistingPath(kiroCliDbPaths());
  if (!dbPath) {
    return {
      found: false,
      error: "No kiro-cli database found. Is kiro-cli installed and logged in?",
    };
  }

  let raw = null;
  const errors = [];

  // Each strategy is independent: better-sqlite3 (native), node:sqlite
  // (built-in, Node >= 22.5), then the `sqlite3` CLI. A failure in one must
  // not stop the next, so collect and try in order.
  for (const read of [readViaBetterSqlite, readViaNodeSqlite]) {
    try {
      raw = await read(dbPath);
      if (raw) break;
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (!raw) {
    try {
      raw = await readViaSqliteCli(dbPath);
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (!raw) {
    return {
      found: false,
      dbPath,
      error: errors.length
        ? `Could not read kiro-cli credentials: ${errors.join("; ")}`
        : "kiro-cli has no stored social token. Run `kiro-cli login` first.",
    };
  }

  const token = parseTokenBlob(raw);
  if (!token) {
    return {
      found: false,
      dbPath,
      error: "kiro-cli's stored token is unreadable or has no refresh token.",
    };
  }

  return { found: true, dbPath, token };
}
