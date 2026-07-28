import fs from "node:fs";
import path from "path";
import os from "os";

const APP_NAME = "9router";

function defaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

export function getDataDir() {
  const configured = process.env.DATA_DIR;
  const isProductionBuild =
    process.env.NINEROUTER_BUILD === "1" ||
    String(process.env.NEXT_PHASE || "").includes("phase-production-build");

  // A Next.js build may import server routes in multiple worker processes.
  // Never let those workers initialize or persist the user's real database.
  if (isProductionBuild && !configured) {
    throw new Error(
      "[DB] Refusing to use the default data directory during next build. " +
      "Run npm run build (safe wrapper) or set DATA_DIR to a disposable directory."
    );
  }

  if (!configured) return defaultDir();

  // Build workers must never share a sql.js file. Give each process an isolated
  // disposable database beneath the wrapper-provided DATA_DIR.
  const effectiveDir = isProductionBuild
    ? path.join(configured, `worker-${process.pid}`)
    : configured;

  // On Windows, ignore Unix-style absolute paths (e.g. /var/lib/...) that come
  // from a Linux-targeted .env or Docker config — they are not valid here.
  if (process.platform === "win32" && /^\//.test(effectiveDir)) {
    console.warn(`[DATA_DIR] '${effectiveDir}' is a Unix path on Windows → fallback to default`);
    return defaultDir();
  }

  try {
    fs.mkdirSync(effectiveDir, { recursive: true });
    return effectiveDir;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      if (isProductionBuild) throw e;
      console.warn(`[DATA_DIR] '${effectiveDir}' not writable → fallback ~/.${APP_NAME}`);
      return defaultDir();
    }
    throw e;
  }
}

export const DATA_DIR = getDataDir();
