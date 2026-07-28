import fs from "node:fs";
import initSqlJs from "sql.js";
import { PRAGMA_SQL } from "../schema.js";

let SQL = null;

async function loadSql() {
  if (SQL) return SQL;
  SQL = await initSqlJs();
  return SQL;
}

export async function createSqlJsAdapter(filePath) {
  const SQLLib = await loadSql();

  // Keep a bounded, byte-for-byte snapshot before sql.js can mutate an existing
  // production database. Build databases are disposable and do not need this.
  if (process.env.NINEROUTER_BUILD !== "1" && fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath);
    const sqliteHeader = existing.subarray(0, 16).toString("binary");
    if (existing.length > 0 && sqliteHeader === "SQLite format 3\u0000") {
      const backupDir = `${filePath}.startup-backups`;
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.copyFileSync(filePath, `${backupDir}/data-${stamp}-${process.pid}.sqlite`, fs.constants.COPYFILE_EXCL);
      const backups = fs.readdirSync(backupDir)
        .filter((name) => name.endsWith(".sqlite"))
        .sort()
        .reverse();
      for (const stale of backups.slice(5)) fs.unlinkSync(`${backupDir}/${stale}`);
    }
  }

  const buf = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  const db = new SQLLib.Database(buf);
  let knownFileStamp = fs.existsSync(filePath)
    ? `${fs.statSync(filePath).mtimeMs}:${fs.statSync(filePath).size}`
    : null;
  db.exec(PRAGMA_SQL);
  // Schema is created/synced by migrate.js after adapter init

  let dirty = false;
  let saveTimer = null;
  const SAVE_DEBOUNCE_MS = 100;

  function persist() {
    // sql.js keeps an in-memory snapshot. Refuse to overwrite a file changed by
    // another process after this adapter opened it; last-writer-wins is data loss.
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      const currentStamp = `${stat.mtimeMs}:${stat.size}`;
      if (knownFileStamp !== null && currentStamp !== knownFileStamp) {
        throw new Error(`[sqljs] database changed by another process; refusing stale overwrite: ${filePath}`);
      }
    } else if (knownFileStamp !== null) {
      throw new Error(`[sqljs] database disappeared; refusing to recreate from stale memory: ${filePath}`);
    }

    const data = Buffer.from(db.export());
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, data, { flag: "wx", mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    const stat = fs.statSync(filePath);
    knownFileStamp = `${stat.mtimeMs}:${stat.size}`;
    dirty = false;
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (dirty) {
        try { persist(); } catch (e) { console.error("[sqljs] save failed:", e); }
      }
    }, SAVE_DEBOUNCE_MS);
  }

  function paramsObj(params) {
    if (!params || (Array.isArray(params) && params.length === 0)) return undefined;
    return params;
  }

  function run(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      stmt.step();
      const changes = db.getRowsModified();
      const lastInsertRowid = db.exec("SELECT last_insert_rowid() as id")[0]?.values?.[0]?.[0] ?? null;
      scheduleSave();
      return { changes, lastInsertRowid };
    } finally {
      stmt.free();
    }
  }

  function get(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      if (stmt.step()) return stmt.getAsObject();
      return undefined;
    } finally {
      stmt.free();
    }
  }

  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  function exec(sql) {
    db.exec(sql);
    scheduleSave();
  }

  function transaction(fn) {
    const sp = `sp_${Math.random().toString(36).slice(2)}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${sp}`);
      scheduleSave();
      return result;
    } catch (e) {
      try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch {}
      throw e;
    }
  }

  function close() {
    if (saveTimer) clearTimeout(saveTimer);
    if (dirty) persist();
    db.close();
  }

  // Flush on shutdown
  const flush = () => { if (dirty) try { persist(); } catch {} };
  process.on("beforeExit", flush);
  process.on("SIGINT", flush);
  process.on("SIGTERM", flush);

  return { driver: "sql.js", run, get, all, exec, transaction, close, raw: db };
}
