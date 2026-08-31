#!/usr/bin/env node

/**
 * grok-cli account canary — probes accounts DIRECTLY against cli-chat-proxy
 * (bypasses 9router routing) and reports which ones are actually usable.
 *
 * Each account is graded on three axes, because a grok-cli account can answer
 * text while being useless for agent work:
 *   1. reachability — HTTP status (402 spending-limit, 403 denied, 429 quota…)
 *   2. instruction following — "print <n>" must echo the digits back
 *   3. tool calling — a dummy tool must produce real function_call items;
 *      grok-4.6 often *describes* the call as text instead, and it is flaky per
 *      attempt, so the probe repeats (--attempts) and scores the hit ratio
 *
 * `print 407` is NOT usable as a canary: xAI's tokenizer substitutes 407 -> 202
 * on every account (verified across farmed + real accounts, two egress IPs and
 * two models), so it fails even on healthy accounts. Use CONTROL_NUMBERS.
 *
 * Usage:
 *   node scripts/grok-cli-canary.mjs [--limit 10] [--model grok-4.6]
 *                                    [--effort high] [--attempts 3]
 *                                    [--concurrency 4] [--timeout 90]
 *                                    [--include-inactive] [--json]
 *
 * --json streams one NDJSON verdict per line as accounts finish, so a long scan
 * can be tailed live and killing it never discards collected results.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const limit = Math.max(1, Math.min(200, Number(value("--limit", "10")) || 10));
const model = value("--model", "grok-4.6");
// effort MUST default to high: with `low`, grok-4.6 *describes* tool calls as
// text ("invoke tool report_status with code is 512") instead of emitting a
// function_call item, so every account would look broken. Verified 2026-08-31.
const effort = value("--effort", "high");
const timeoutMs = Math.max(10, Number(value("--timeout", "90")) || 90) * 1000;
// grok-4.6 tool calling is FLAKY: the same prompt/effort emits a real
// function_call on one attempt and merely describes it as text on the next
// ("call tool report_status with code is 512"). One shot cannot grade an
// account — probe repeatedly and score the ratio.
const attempts = Math.max(1, Math.min(10, Number(value("--attempts", "3")) || 3));
const concurrency = Math.max(1, Math.min(12, Number(value("--concurrency", "4")) || 4));
const includeInactive = args.includes("--include-inactive");
const asJson = args.includes("--json");

const DB_PATH = process.env.NINEROUTER_DB
  || path.join(os.homedir(), ".9router", "db", "data.sqlite");
const ENDPOINT = "https://cli-chat-proxy.grok.com/v1/responses";
// Control numbers verified to survive tokenization (unlike 407 -> 202).
const CONTROL_NUMBERS = ["512", "777", "913"];

function loadAccounts() {
  const where = includeInactive ? "" : " AND isActive=1";
  const raw = execFileSync("sqlite3", [
    "-json", DB_PATH,
    `SELECT id, data FROM providerConnections WHERE provider='grok-cli'${where} LIMIT ${limit};`,
  ]).toString().trim();
  if (!raw) return [];
  return JSON.parse(raw).map((row) => {
    const data = JSON.parse(row.data);
    const psd = data.providerSpecificData || {};
    return {
      id: row.id,
      label: psd.email || data.displayName || row.id.slice(0, 8),
      token: data.accessToken,
      email: psd.email || "",
      userId: psd.userId || "",
    };
  });
}

function buildHeaders(account) {
  const sessionId = crypto.randomUUID();
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${account.token}`,
    "User-Agent": "grok-shell/1.0.3 (linux; x86_64)",
    "x-grok-client-identifier": "grok-shell",
    "x-grok-client-version": "1.0.3",
    "x-xai-token-auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    "x-grok-client-mode": "headless",
    "x-grok-doom-loop-check": "true",
    "x-compaction-at": "400000",
    "x-compactions-remaining": "1",
    "x-grok-session-id": sessionId,
    "x-grok-conv-id": sessionId,
    "x-grok-req-id": crypto.randomUUID(),
    "x-grok-turn-idx": "1",
    "x-grok-model-override": model,
    "x-email": account.email,
    "x-grok-user-id": account.userId,
    "x-userid": account.userId,
  };
}

/** Collect assistant text + function calls out of the Responses SSE stream. */
function parseStream(text) {
  let out = "";
  const toolCalls = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let event;
    try { event = JSON.parse(payload); } catch { continue; }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      out += event.delta;
    }
    const item = event.item;
    if (event.type === "response.output_item.done" && item?.type === "function_call") {
      toolCalls.push({ name: item.name, args: item.arguments });
    }
  }
  return { text: out.trim(), toolCalls };
}

async function callUpstream(account, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: buildHeaders(account),
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    const parsed = parseStream(raw);
    let error = null;
    if (response.status !== 200) {
      try { error = JSON.parse(raw)?.code || JSON.parse(raw)?.error || raw.slice(0, 80); }
      catch { error = raw.slice(0, 80); }
    }
    return { status: response.status, ms: Date.now() - startedAt, error, ...parsed };
  } catch (e) {
    return { status: 0, ms: Date.now() - startedAt, error: e.name, text: "", toolCalls: [] };
  } finally {
    clearTimeout(timer);
  }
}

const baseBody = (input, tools) => ({
  model,
  input,
  stream: true,
  store: false,
  // Mirror the production executor wire (open-sse/executors/grok-cli.js) so a
  // canary verdict transfers to real routed traffic.
  include: ["reasoning.encrypted_content"],
  reasoning: { summary: "concise", ...(effort === "none" ? {} : { effort }) },
  prompt_cache_key: crypto.randomUUID(),
  ...(tools ? { tools, tool_choice: "auto" } : {}),
});

const userMessage = (text) => [{
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
}];

const ECHO_TOOL = [{
  type: "function",
  name: "report_status",
  description: "Report a status code back to the operator. Call this to answer.",
  parameters: {
    type: "object",
    properties: { code: { type: "string", description: "the status code to report" } },
    required: ["code"],
  },
}];

async function gradeAccount(account) {
  const number = CONTROL_NUMBERS[Math.floor(Math.random() * CONTROL_NUMBERS.length)];

  const echo = await callUpstream(account, baseBody(userMessage(`print ${number}`)));
  const echoDigits = echo.text.replace(/\D/g, "");
  const echoOk = echo.status === 200 && echoDigits === number;

  // Tool calling is flaky per-attempt; grade on how often a real function_call
  // lands. A text description of the call ("call tool X with …") counts as fail.
  let toolHits = 0;
  let toolMs = 0;
  let toolStatus = 0;
  let toolError = null;
  const observed = [];
  for (let i = 0; i < attempts; i += 1) {
    const tool = await callUpstream(
      account,
      baseBody(userMessage(`Report the code ${number} using the available tool.`), ECHO_TOOL),
    );
    toolMs += tool.ms;
    toolStatus = tool.status;
    toolError = toolError || tool.error;
    const hit = tool.status === 200
      && tool.toolCalls.some((c) => c.name === "report_status" && String(c.args || "").includes(number));
    if (hit) toolHits += 1;
    else if (tool.text) observed.push(tool.text.slice(0, 40));
  }

  const toolRate = toolHits / attempts;
  const reachable = echo.status === 200;
  const verdict = !reachable
    ? "DEAD"
    : !echoOk
      ? "DUMB"
      : toolRate >= 0.67
        ? "HEALTHY"
        : toolRate > 0
          ? "FLAKY"
          : "NO_TOOLS";

  return {
    account: account.label,
    id: account.id,
    verdict,
    echo: { ok: echoOk, want: number, got: echo.text.slice(0, 40), status: echo.status, ms: echo.ms, error: echo.error },
    tools: { hits: toolHits, attempts, rate: toolRate, status: toolStatus, ms: toolMs, error: toolError, observed: observed.slice(0, 2) },
  };
}

const accounts = loadAccounts();
if (!accounts.length) {
  console.error(`No grok-cli accounts found in ${DB_PATH}`);
  process.exit(1);
}

if (!asJson) {
  console.log(`Canary: ${accounts.length} account(s) → ${ENDPOINT} (model=${model}, effort=${effort})\n`);
}

const results = [];
let cursor = 0;

function renderRow(result) {
  const icon = { HEALTHY: "✅", FLAKY: "🟠", NO_TOOLS: "🟡", DUMB: "❌", DEAD: "💀" }[result.verdict];
  const echoCell = result.echo.ok
    ? `echo ${result.echo.want} ok`
    : `echo want ${result.echo.want} got ${JSON.stringify(result.echo.got)}${result.echo.error ? ` [${result.echo.error}]` : ""}`;
  const toolCell = `tool ${result.tools.hits}/${result.tools.attempts}`
    + (result.tools.hits < result.tools.attempts && result.tools.observed.length
      ? ` (text: ${JSON.stringify(result.tools.observed[0])})`
      : "")
    + (result.tools.error ? ` [${result.tools.error}]` : "");
  console.log(`${icon} ${result.verdict.padEnd(8)} ${result.account.slice(0, 40).padEnd(42)} | ${echoCell} | ${toolCell} | ${result.echo.ms}+${result.tools.ms}ms`);
}

// Workers pull from a shared cursor: a slow/timing-out account cannot stall the
// whole scan, and every finished account is emitted immediately (NDJSON in
// --json mode) so killing the run never loses collected verdicts.
async function worker() {
  for (;;) {
    const index = cursor++;
    if (index >= accounts.length) return;
    const result = await gradeAccount(accounts[index]);
    results.push(result);
    if (asJson) console.log(JSON.stringify(result));
    else renderRow(result);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, worker));

if (asJson) process.exit(0);

const tally = results.reduce((acc, r) => { acc[r.verdict] = (acc[r.verdict] || 0) + 1; return acc; }, {});
console.log(`\nHEALTHY=${tally.HEALTHY || 0} FLAKY=${tally.FLAKY || 0} NO_TOOLS=${tally.NO_TOOLS || 0} DUMB=${tally.DUMB || 0} DEAD=${tally.DEAD || 0}`);
console.log(`Each account consumed ${1 + attempts} inference calls of real quota.`);
console.log("Verdicts: HEALTHY = tool calls land >=2/3 · FLAKY = sometimes · NO_TOOLS = never · DUMB = cannot echo a control number · DEAD = upstream refused.");
