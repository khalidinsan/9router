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
