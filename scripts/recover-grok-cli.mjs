#!/usr/bin/env node

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const apply = args.includes("--apply");
const baseUrl = value("--base-url", "http://127.0.0.1:20127").replace(/\/$/, "");
const modelId = value("--model", "grok-4.5");
const limit = Math.max(1, Math.min(50, Number(value("--limit", "10")) || 10));
const cliToken = value("--cli-token", process.env.NINEROUTER_CLI_TOKEN || "");
const cookie = value("--cookie", process.env.NINEROUTER_AUTH_COOKIE || "");
const headers = { "Content-Type": "application/json" };
if (cliToken) headers["x-9r-cli-token"] = cliToken;
if (cookie) headers.Cookie = cookie;

const response = await fetch(`${baseUrl}/api/providers/grok-cli/recover`, {
  method: "POST",
  headers,
  body: JSON.stringify({ modelId, limit, apply }),
});
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(body.error || `Recovery API failed with HTTP ${response.status}`);
  process.exit(1);
}

console.log(JSON.stringify(body, null, 2));
if (!apply) {
  console.log("\nProbe-only run: no accounts were enabled, but real upstream inference requests were sent and may consume quota. Review results, then rerun with --apply.");
} else if (body.remaining > 0) {
  console.log(`\n${body.remaining} candidates remain. Run the same command again for the next batch.`);
}
