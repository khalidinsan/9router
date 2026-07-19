import { NextResponse } from "next/server";

if (!globalThis.accountAutomationRuns || typeof globalThis.accountAutomationRuns.get !== "function") {
  globalThis.accountAutomationRuns = new Map();
}

/**
 * Force-stop a running automation (Grok farm pool + Chromium, or login queue).
 *
 * POST { runId: string }
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const runId = String(body.runId || "").trim();
    if (!runId) {
      return NextResponse.json({ error: "runId is required" }, { status: 400 });
    }

    const run = globalThis.accountAutomationRuns.get(runId);
    if (!run) {
      return NextResponse.json({ error: "run not found" }, { status: 404 });
    }

    if (run.status !== "running" && run.status !== "stopping") {
      return NextResponse.json({
        ok: true,
        runId,
        status: run.status,
        message: `Run already ${run.status}`,
      });
    }

    run.status = "stopping";
    run.logs.push({
      level: "warn",
      step: "stop",
      message: "Force stop requested from UI…",
      time: new Date().toISOString(),
    });

    if (typeof run.abort === "function") {
      try {
        run.abort();
      } catch (e) {
        run.logs.push({
          level: "error",
          step: "stop",
          message: `abort failed: ${e.message}`,
          time: new Date().toISOString(),
        });
      }
    } else {
      // No process handle (login queue may not expose abort yet) — mark stopped
      run.status = "stopped";
      run.endedAt = new Date().toISOString();
      run.summary = run.summary || {
        total: run.count || run.accounts?.length || 0,
        success: (run.results || []).filter((r) => r.success).length,
        failed: 0,
        errors: ["Stopped (no process abort handle)"],
        stopped: true,
        status: "stopped",
      };
      run.logs.push({
        level: "warn",
        step: "stop",
        message: "No abort handle — marked stopped (worker may still exit on its own)",
        time: new Date().toISOString(),
      });
    }

    return NextResponse.json({
      ok: true,
      runId,
      status: run.status,
      message: "Stop signal sent",
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ error: "method not allowed" }, { status: 405 });
}
