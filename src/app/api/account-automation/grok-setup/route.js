import { NextResponse } from "next/server";

/**
 * GET  — readiness status for bundled Grok register farm
 * POST — run setup_env.py (venv + deps + Playwright Chromium)
 *
 * Setup runs in-process async; logs appended to a short-lived setup run id
 * when body.stream is false we just run and return final status.
 */

if (!globalThis.accountAutomationRuns || typeof globalThis.accountAutomationRuns.get !== "function") {
  globalThis.accountAutomationRuns = new Map();
}

export async function GET() {
  try {
    const { getGrokRegisterStatus } = await import(
      "../../../../../open-sse/services/automation/providers/GrokRegisterRunner.js"
    );
    const status = await getGrokRegisterStatus();
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const streamToRun = Boolean(body.runId);

    const { setupGrokRegister, getGrokRegisterStatus } = await import(
      "../../../../../open-sse/services/automation/providers/GrokRegisterRunner.js"
    );

    if (streamToRun) {
      const runId = body.runId;
      const run = globalThis.accountAutomationRuns.get(runId);
      if (!run) {
        return NextResponse.json({ error: "run not found" }, { status: 404 });
      }
      // fire and forget — client already on SSE
      setupGrokRegister({
        onLog: (log) => {
          const current = globalThis.accountAutomationRuns.get(runId);
          if (current) {
            current.logs.push({ ...log, time: new Date().toISOString() });
          }
        },
      })
        .then((status) => {
          const current = globalThis.accountAutomationRuns.get(runId);
          if (current) {
            current.status = "done";
            current.endedAt = new Date().toISOString();
            current.summary = {
              total: 1,
              success: status.ready || status.venvPython ? 1 : 0,
              failed: status.ready || status.venvPython ? 0 : 1,
              status: "setup-done",
              grokStatus: status,
            };
          }
        })
        .catch((err) => {
          const current = globalThis.accountAutomationRuns.get(runId);
          if (current) {
            current.status = "failed";
            current.endedAt = new Date().toISOString();
            current.error = err.message;
            current.logs.push({
              level: "error",
              step: "setup",
              message: err.message,
              time: new Date().toISOString(),
            });
          }
        });
      return NextResponse.json({ ok: true, runId, status: "running" });
    }

    // Synchronous setup (may take minutes) — return final status
    const logs = [];
    const status = await setupGrokRegister({
      onLog: (log) => logs.push(log),
    });
    return NextResponse.json({ ok: true, status, logs });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error.message,
        status: null,
      },
      { status: 500 },
    );
  }
}
