"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Card,
  Button,
  Input,
  Select,
  Badge,
} from "@/shared/components";

const PROVIDER_OPTIONS = [
  { value: "antigravity", label: "Antigravity" },
  { value: "kiro", label: "Kiro" },
];

const LEVEL_COLORS = {
  info: "text-blue-400",
  success: "text-green-400",
  warn: "text-yellow-400",
  error: "text-red-400",
};

export default function AddAccountPage() {
  const [provider, setProvider] = useState("antigravity");
  const [accountsInput, setAccountsInput] = useState("");
  const [proxy, setProxy] = useState("");
  const [headless, setHeadless] = useState(true);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState([]);
  const [results, setResults] = useState([]);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const logRef = useRef(null);
  const eventSourceRef = useRef(null);

  const parseAccounts = useCallback(() => {
    return accountsInput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const sep = line.includes(":") ? ":" : "|";
        const idx = line.indexOf(sep);
        if (idx === -1) return null;
        return {
          email: line.slice(0, idx).trim(),
          password: line.slice(idx + 1).trim(),
        };
      })
      .filter((a) => a && a.email && a.password);
  }, [accountsInput]);

  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => closeEventSource();
  }, [closeEventSource]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const appendLog = useCallback((entry) => {
    setLogs((prev) => [...prev, entry]);
  }, []);

  const handleRun = async () => {
    const accounts = parseAccounts();
    if (accounts.length === 0) {
      setError("Enter at least one account in email:password format.");
      return;
    }

    setRunning(true);
    setLogs([]);
    setResults([]);
    setSummary(null);
    setError(null);
    closeEventSource();

    try {
      const res = await fetch("/api/account-automation/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          accounts,
          headless,
          proxy: proxy.trim() || null,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to start automation");
      }

      const runId = data.runId;
      if (!runId) {
        throw new Error("No run ID returned from server");
      }

      const es = new EventSource(`/api/account-automation/stream?runId=${encodeURIComponent(runId)}`);
      eventSourceRef.current = es;

      es.addEventListener("log", (e) => {
        try {
          const log = JSON.parse(e.data);
          appendLog(log);
        } catch {
          appendLog({ level: "info", step: "raw", message: e.data });
        }
      });

      es.addEventListener("result", (e) => {
        try {
          const result = JSON.parse(e.data);
          setResults((prev) => [...prev, result]);
        } catch {
          // ignore malformed result
        }
      });

      es.addEventListener("done", (e) => {
        try {
          const doneSummary = JSON.parse(e.data);
          setSummary(doneSummary);
        } catch {
          // ignore malformed summary
        }
        closeEventSource();
        setRunning(false);
      });

      es.addEventListener("error", (e) => {
        let message = "SSE connection failed";
        try {
          const data = JSON.parse(e.data);
          message = data.message || message;
        } catch {
          // keep default message
        }
        appendLog({ level: "error", step: "sse", message });
        closeEventSource();
        setRunning(false);
      });

      es.onerror = () => {
        appendLog({ level: "error", step: "sse", message: "EventSource error" });
        closeEventSource();
        setRunning(false);
      };
    } catch (err) {
      setError(err.message);
      appendLog({ level: "error", step: "start", message: err.message });
      setRunning(false);
    }
  };

  const parsedCount = parseAccounts().length;

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
          Add Account
        </h1>
        <p className="text-sm text-text-muted">
          Bulk-automate provider logins with email and password credentials.
        </p>
      </div>

      <Card>
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-text-main">Provider</label>
            <Select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              options={PROVIDER_OPTIONS}
              selectClassName="w-full sm:w-64"
            />
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-text-main">
                Accounts
              </label>
              <span className="text-xs text-text-muted">
                {parsedCount} account{parsedCount === 1 ? "" : "s"} parsed
              </span>
            </div>
            <textarea
              value={accountsInput}
              onChange={(e) => setAccountsInput(e.target.value)}
              placeholder="email:password&#10;email2:password2"
              className="w-full h-40 px-3 py-2.5 text-sm text-text-main bg-surface-2 rounded-[10px] border border-transparent placeholder-text-muted/70 focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40 transition-all duration-150 ease-out font-mono resize-y"
            />
            <p className="text-xs text-text-muted">
              One account per line, using <code className="text-text-main">:</code> or{" "}
              <code className="text-text-main">|</code> as the separator.
            </p>
          </div>

          <Input
            label="Proxy (optional)"
            placeholder="http://user:pass@proxy:8080"
            value={proxy}
            onChange={(e) => setProxy(e.target.value)}
            hint="Used for all browser automation contexts in this run."
          />

          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={headless}
              onChange={(e) => setHeadless(e.target.checked)}
              className="size-4 rounded border-border bg-surface-2 text-brand-500 focus:ring-brand-500/30"
            />
            <span className="text-sm text-text-main">Run browser in headless mode</span>
          </label>

          {error && (
            <div className="flex items-center gap-2 text-xs text-red-500">
              <span className="material-symbols-outlined text-[16px]">error</span>
              {error}
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button
              onClick={handleRun}
              disabled={running || parsedCount === 0}
              loading={running}
              icon="play_arrow"
            >
              Run Automation
            </Button>
            {running && (
              <span className="text-sm text-text-muted animate-pulse">
                Automation running…
              </span>
            )}
          </div>
        </div>
      </Card>

      {(logs.length > 0 || running) && (
        <Card title="Progress Log" icon="terminal">
          <div
            ref={logRef}
            className="bg-black rounded-b-lg p-4 text-xs font-mono h-80 overflow-y-auto"
          >
            {logs.length === 0 ? (
              <span className="text-text-muted">Waiting for logs…</span>
            ) : (
              <div className="space-y-1">
                {logs.map((log, i) => (
                  <div key={i} className="break-words">
                    <span className="text-text-muted">
                      {log.time ? new Date(log.time).toLocaleTimeString() : ""}
                    </span>
                    {log.step && (
                      <span className="text-text-muted ml-2">[{log.step}]</span>
                    )}
                    <span className={`ml-2 ${LEVEL_COLORS[log.level] || "text-green-400"}`}>
                      {log.message}
                    </span>
                    {log.email && (
                      <span className="text-text-muted ml-2">({log.email})</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}

      {results.length > 0 && (
        <Card title="Results" icon="checklist">
          <div className="flex flex-col gap-2">
            {results.map((result, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-lg bg-bg px-3 py-2 border border-border-subtle"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`material-symbols-outlined text-[18px] ${
                      result.success ? "text-green-500" : "text-red-500"
                    }`}
                  >
                    {result.success ? "check_circle" : "error"}
                  </span>
                  <span className="text-sm font-medium truncate">{result.email}</span>
                </div>
                {result.success ? (
                  <Badge variant="success" size="sm">Connected</Badge>
                ) : (
                  <Badge variant="error" size="sm">Failed</Badge>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {summary && (
        <Card title="Summary" icon="summarize">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-text-muted">
              Total: <strong className="text-text-main">{summary.total}</strong>
            </span>
            <span className="text-green-500">
              Success: <strong>{summary.success}</strong>
            </span>
            <span className="text-red-500">
              Failed: <strong>{summary.failed}</strong>
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}
