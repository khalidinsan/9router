import { NextResponse } from "next/server";
import { randomUUID } from "crypto";

const SUPPORTED_PROVIDERS = ["antigravity", "kiro"];

if (!globalThis.accountAutomationRuns) {
  globalThis.accountAutomationRuns = new Map();
}

function validateAccounts(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return { valid: false, error: "accounts must be a non-empty array" };
  }
  for (const account of accounts) {
    if (!account || typeof account !== "object") {
      return { valid: false, error: "each account must be an object" };
    }
    if (typeof account.email !== "string" || account.email.trim() === "") {
      return { valid: false, error: "each account must have a non-empty email string" };
    }
    if (typeof account.password !== "string" || account.password === "") {
      return { valid: false, error: "each account must have a password string" };
    }
  }
  return { valid: true };
}

function validateProvider(provider) {
  if (typeof provider !== "string" || !SUPPORTED_PROVIDERS.includes(provider)) {
    return { valid: false, error: `provider must be one of ${SUPPORTED_PROVIDERS.join(", ")}` };
  }
  return { valid: true };
}

async function spawnAutomation(runId, provider, accounts, options) {
  const run = globalThis.accountAutomationRuns.get(runId);
  if (!run) return;

  const [{ AutomationQueue }, { AntigravityAutomation }, { KiroAutomation }] = await Promise.all([
    import("../../../../../open-sse/services/automation/core/AutomationQueue.js"),
    import("../../../../../open-sse/services/automation/providers/AntigravityAutomation.js"),
    import("../../../../../open-sse/services/automation/providers/KiroAutomation.js"),
  ]);

  const providerFactories = {
    antigravity: (opts) => new AntigravityAutomation(opts),
    kiro: (opts) => new KiroAutomation(opts),
  };

  const queue = new AutomationQueue({
    headless: options.headless,
    proxy: options.proxy,
    concurrency: 1,
    onLog: (log) => {
      const current = globalThis.accountAutomationRuns.get(runId);
      if (current) {
        current.logs.push({ ...log, time: new Date().toISOString() });
      }
    },
    onResult: (result) => {
      const current = globalThis.accountAutomationRuns.get(runId);
      if (current) {
        current.results.push(result);
      }
    },
    onDone: (summary) => {
      const current = globalThis.accountAutomationRuns.get(runId);
      if (current) {
        current.status = summary.failed > 0 && summary.success === 0 ? "failed" : "done";
        current.endedAt = new Date().toISOString();
        current.summary = summary;
      }
    },
  });

  try {
    const jobs = accounts.map((account) => ({ ...account, provider }));
    await queue.run(jobs, (p, opts) => providerFactories[p](opts));
  } catch (error) {
    const current = globalThis.accountAutomationRuns.get(runId);
    if (current) {
      current.status = "failed";
      current.endedAt = new Date().toISOString();
      current.error = error.message;
      current.logs.push({
        level: "error",
        step: "queue",
        message: error.message,
        time: new Date().toISOString(),
      });
    }
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { provider, accounts, headless = true, proxy = null } = body;

    const providerValidation = validateProvider(provider);
    if (!providerValidation.valid) {
      return NextResponse.json({ error: providerValidation.error }, { status: 400 });
    }

    const accountsValidation = validateAccounts(accounts);
    if (!accountsValidation.valid) {
      return NextResponse.json({ error: accountsValidation.error }, { status: 400 });
    }

    const runId = randomUUID();
    const run = {
      runId,
      provider,
      accounts: accounts.map(({ email, password }) => ({ email, password })),
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      logs: [],
      results: [],
    };

    globalThis.accountAutomationRuns.set(runId, run);

    spawnAutomation(runId, provider, run.accounts, { headless, proxy });

    return NextResponse.json({
      runId,
      status: "running",
      total: accounts.length,
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ error: "method not allowed" }, { status: 405 });
}

export async function PUT() {
  return NextResponse.json({ error: "method not allowed" }, { status: 405 });
}

export async function DELETE() {
  return NextResponse.json({ error: "method not allowed" }, { status: 405 });
}
