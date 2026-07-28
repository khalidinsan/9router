import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-build-data-"));
const nextBin = path.resolve("node_modules", "next", "dist", "bin", "next");

console.log(`[build] isolated DATA_DIR: ${tempDataDir}`);

const child = spawn(process.execPath, [nextBin, "build", "--webpack", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    DATA_DIR: tempDataDir,
    NINEROUTER_BUILD: "1",
    NINEROUTER_DB_DRIVER: "sqljs",
  },
});

const forwardSignal = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.once("SIGINT", () => forwardSignal("SIGINT"));
process.once("SIGTERM", () => forwardSignal("SIGTERM"));

child.once("error", (error) => {
  console.error(`[build] failed to start Next.js: ${error.message}`);
  fs.rmSync(tempDataDir, { recursive: true, force: true });
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  fs.rmSync(tempDataDir, { recursive: true, force: true });
  if (signal) {
    console.error(`[build] Next.js terminated by ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
