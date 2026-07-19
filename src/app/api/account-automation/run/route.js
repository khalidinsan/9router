import { NextResponse } from "next/server";
import { randomUUID } from "crypto";

const SUPPORTED_PROVIDERS = ["antigravity", "kiro", "grok-cli"];

if (!globalThis.accountAutomationRuns || typeof globalThis.accountAutomationRuns.get !== "function") {
  globalThis.accountAutomationRuns = new Map();
}

function validateLoginAccounts(accounts) {
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

function attachRunHandlers(runId) {
  return {
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
        // Always terminal when the farm process finished — even if 0 accounts
        // succeeded. "failed" is reserved for hard crashes (no summary / spawn errors).
        // "stopped" = user force-stop.
        const st = summary?.stopped
          ? "stopped"
          : current.status === "stopping"
            ? "stopped"
            : "done";
        current.status = st;
        current.endedAt = new Date().toISOString();
        current.summary = {
          total: summary?.total ?? 0,
          success: summary?.success ?? 0,
          failed: summary?.failed ?? 0,
          errors: summary?.errors || [],
          stopped: Boolean(summary?.stopped),
          status: st,
        };
        current.abort = null;
      }
    },
  };
}

async function spawnLoginAutomation(runId, provider, accounts, options) {
  const run = globalThis.accountAutomationRuns.get(runId);
  if (!run) return;

  const handlers = attachRunHandlers(runId);

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
    ...handlers,
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

/**
 * Grok CLI register: spawn external grok-register farm (Python).
 * Creates NEW accounts (catch-all email + SSO→Build OAuth → push grok-cli).
 */
async function spawnGrokRegister(runId, options) {
  const run = globalThis.accountAutomationRuns.get(runId);
  if (!run) return;

  const handlers = attachRunHandlers(runId);

  try {
    const { runGrokRegister } = await import(
      "../../../../../open-sse/services/automation/providers/GrokRegisterRunner.js"
    );
    await runGrokRegister({
      count: options.count,
      concurrent: options.concurrent,
      headless: options.headless,
      proxy: options.proxy,
      display: options.display,
      stagger: options.stagger,
      autoSetup: options.autoSetup !== false,
      email: options.email || null,
      registerAbort: (fn) => {
        const current = globalThis.accountAutomationRuns.get(runId);
        if (current) current.abort = fn;
      },
      ...handlers,
    });
  } catch (error) {
    const current = globalThis.accountAutomationRuns.get(runId);
    if (current) {
      // Force-stop also rejects/aborts mid-flight in some paths
      if (current.status === "stopping" || current.status === "stopped") {
        current.status = "stopped";
        current.endedAt = new Date().toISOString();
        current.abort = null;
        if (!current.summary) {
          current.summary = {
            total: options.count || 0,
            success: current.results.filter((r) => r.success).length,
            failed: 0,
            errors: ["Force stopped by user"],
            stopped: true,
            status: "stopped",
          };
        }
        return;
      }
      current.status = "failed";
      current.endedAt = new Date().toISOString();
      current.error = error.message;
      current.abort = null;
      current.logs.push({
        level: "error",
        step: "grok-register",
        message: error.message,
        time: new Date().toISOString(),
      });
      if (!current.summary) {
        current.summary = {
          total: options.count || 0,
          success: current.results.filter((r) => r.success).length,
          failed: 1,
          errors: [error.message],
        };
      }
    }
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const {
      provider,
      accounts = [],
      headless = true,
      proxy = null,
      // grok-cli register options
      count = 1,
      concurrent = 1,
      display = null,
      stagger = 15,
      email: emailFromBody = null,
    } = body;

    const providerValidation = validateProvider(provider);
    if (!providerValidation.valid) {
      return NextResponse.json({ error: providerValidation.error }, { status: 400 });
    }

    // --- Grok CLI Register (farm) ---
    if (provider === "grok-cli") {
      const total = Math.max(1, Number(count) || 1);
      const conc = Math.max(1, Number(concurrent) || 1);
      if (total > 500) {
        return NextResponse.json({ error: "count max is 500 per run" }, { status: 400 });
      }
      if (conc > 10) {
        return NextResponse.json({ error: "concurrent max is 10" }, { status: 400 });
      }

      const runId = randomUUID();
      const run = {
        runId,
        provider,
        mode: "register",
        accounts: [],
        count: total,
        concurrent: conc,
        status: "running",
        startedAt: new Date().toISOString(),
        endedAt: null,
        logs: [],
        results: [],
      };
      globalThis.accountAutomationRuns.set(runId, run);

      // Prefer email from request body; else load from 9router settings (Add Account form)
      let emailCfg = emailFromBody || null;
      if (!emailCfg?.domain || !emailCfg?.imapUser || !(emailCfg?.imapPass || emailCfg?.hasImapPass)) {
        try {
          const { getSettings } = await import("@/lib/localDb");
          const s = await getSettings();
          emailCfg = {
            domain: (emailCfg?.domain || s.grokRegisterEmailDomain || "").trim(),
            imapUser: (emailCfg?.imapUser || s.grokRegisterImapUser || "").trim(),
            imapPass: (emailCfg?.imapPass || s.grokRegisterImapPass || "").trim(),
            imapHost: (emailCfg?.imapHost || s.grokRegisterImapHost || "imap.gmail.com").trim(),
            imapPort: Number(emailCfg?.imapPort || s.grokRegisterImapPort) || 993,
          };
        } catch {
          emailCfg = emailCfg || {};
        }
      }

      spawnGrokRegister(runId, {
        count: total,
        concurrent: conc,
        headless: Boolean(headless),
        proxy: proxy || null,
        display: display || null,
        stagger: Number(stagger) || 15,
        email: emailCfg,
      });

      return NextResponse.json({
        runId,
        status: "running",
        total,
        concurrent: conc,
        mode: "register",
      });
    }

    // --- Login automations (antigravity / kiro) ---
    const accountsValidation = validateLoginAccounts(accounts);
    if (!accountsValidation.valid) {
      return NextResponse.json({ error: accountsValidation.error }, { status: 400 });
    }

    const runId = randomUUID();
    const run = {
      runId,
      provider,
      mode: "login",
      accounts: accounts.map(({ email, password }) => ({ email, password })),
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      logs: [],
      results: [],
    };

    globalThis.accountAutomationRuns.set(runId, run);

    spawnLoginAutomation(runId, provider, run.accounts, { headless, proxy });

    return NextResponse.json({
      runId,
      status: "running",
      total: accounts.length,
      mode: "login",
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
