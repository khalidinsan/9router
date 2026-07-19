import { SseEventEmitter } from "../../../../../open-sse/services/automation/core/SseEventEmitter.js";

if (!globalThis.accountAutomationRuns || typeof globalThis.accountAutomationRuns.get !== "function") {
  globalThis.accountAutomationRuns = new Map();
}

const POLL_INTERVAL_MS = 100;

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get("runId");

  if (!runId) {
    return jsonResponse({ error: "runId is required" }, 400);
  }

  const run = globalThis.accountAutomationRuns.get(runId);
  if (!run) {
    return jsonResponse({ error: "run not found" }, 404);
  }

  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      start(controller) {
        const sseResponse = {
          writeHead: () => {},
          write: (chunk) => controller.enqueue(encoder.encode(chunk)),
          flush: () => {},
        };
        const emitter = new SseEventEmitter(sseResponse);

        let lastLogsLength = (run.logs || []).length;
        let lastResultsLength = (run.results || []).length;

        emitter.emit("init", {
          runId,
          status: run.status,
          logs: run.logs || [],
          results: run.results || [],
        });

        const finishSummary = (currentRun) => {
          const results = currentRun.results || [];
          return (
            currentRun.summary || {
              total: results.length,
              success: results.filter((r) => r.success).length,
              failed: results.filter((r) => !r.success).length,
              status: currentRun.status || "done",
              error: currentRun.error || null,
            }
          );
        };

        // Always end with `done` (summary carries success/failed). Avoid SSE `error`
        // events for finished runs — they surface as scary red "automation failed"
        // even when the farm exited cleanly with 0 accounts registered.
        if (run.status === "done" || run.status === "failed") {
          emitter.done(finishSummary(run));
          controller.close();
          return;
        }

        let intervalId;

        const sendUpdates = () => {
          const currentRun = globalThis.accountAutomationRuns.get(runId);
          if (!currentRun) {
            emitter.done({
              total: 0,
              success: 0,
              failed: 0,
              status: "failed",
              error: "run disappeared",
            });
            clearInterval(intervalId);
            controller.close();
            return;
          }

          const logs = currentRun.logs || [];
          const results = currentRun.results || [];

          while (lastLogsLength < logs.length) {
            const log = logs[lastLogsLength++];
            emitter.emit("log", log);
          }

          while (lastResultsLength < results.length) {
            emitter.result(results[lastResultsLength++]);
          }

          if (currentRun.status === "done" || currentRun.status === "failed") {
            clearInterval(intervalId);
            emitter.done(finishSummary(currentRun));
            controller.close();
          }
        };

        intervalId = setInterval(sendUpdates, POLL_INTERVAL_MS);

        return () => {
          clearInterval(intervalId);
        };
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }
  );
}
