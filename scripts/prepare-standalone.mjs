import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Next.js standalone tracing does not copy browser assets automatically.
// The standalone server resolves them relative to its own .next directory.
const staticSrc = path.join(root, ".next", "static");
const staticDest = path.join(standalone, ".next", "static");
if (fs.existsSync(staticSrc)) {
  copyDir(staticSrc, staticDest);
  console.log("[prepare-standalone] copied .next/static/");
}

// Next.js standalone output should include public/, but copy defensively.
const publicSrc = path.join(root, "public");
const publicDest = path.join(standalone, "public");
if (fs.existsSync(publicSrc)) {
  copyDir(publicSrc, publicDest);
  console.log("[prepare-standalone] copied public/");
}

// sql.js WASM files are not traced into standalone; copy them manually.
const sqlJsSrc = path.join(root, "node_modules", "sql.js", "dist");
const sqlJsDest = path.join(standalone, "node_modules", "sql.js", "dist");
if (fs.existsSync(sqlJsSrc)) {
  copyDir(sqlJsSrc, sqlJsDest);
  console.log("[prepare-standalone] copied sql.js dist/");
}

// Camoufox loads these files at runtime, but Next.js tracing does not include
// non-code package assets automatically.
const camoufoxDataSrc = path.join(root, "node_modules", "camoufox-js", "dist", "data-files");
const camoufoxDataDest = path.join(standalone, "node_modules", "camoufox-js", "dist", "data-files");
if (fs.existsSync(camoufoxDataSrc)) {
  copyDir(camoufoxDataSrc, camoufoxDataDest);
  console.log("[prepare-standalone] copied camoufox data-files/");
}

// Never ship better-sqlite3 in the portable standalone output. Its native
// binary is tied to the Node ABI used during install/build and may not match the
// Node runtime that starts the server. The DB driver will fall back to node:sqlite
// (Node >=22.5) or the bundled sql.js implementation.
const betterSqliteDest = path.join(standalone, "node_modules", "better-sqlite3");
if (fs.existsSync(betterSqliteDest)) {
  fs.rmSync(betterSqliteDest, { recursive: true, force: true });
  console.log("[prepare-standalone] stripped better-sqlite3 native module");
}
