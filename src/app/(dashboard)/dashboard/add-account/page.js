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
  { value: "grok-cli", label: "Grok CLI (Register)" },
];

const DISPLAY_OPTIONS = [
  { value: "offscreen", label: "Offscreen (recommended on Mac)" },
  { value: "headed", label: "Headed (visible window)" },
  { value: "headless", label: "Headless (may fail Turnstile)" },
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
  // Grok CLI register options
  const [count, setCount] = useState(1);
  const [concurrent, setConcurrent] = useState(1);
  const [display, setDisplay] = useState("offscreen");
  const [stagger, setStagger] = useState(15);
  // Email / IMAP (shown on this page — no hunting config files)
  const [emailDomain, setEmailDomain] = useState("");
  const [imapUser, setImapUser] = useState("");
  const [imapPass, setImapPass] = useState("");
  const [imapHost, setImapHost] = useState("imap.gmail.com");
  const [imapPort, setImapPort] = useState(993);
  const [hasSavedImapPass, setHasSavedImapPass] = useState(false);
  const [emailSaveMsg, setEmailSaveMsg] = useState(null);
  const [emailSaving, setEmailSaving] = useState(false);

  const [running, setRunning] = useState(false);
  const [setupRunning, setSetupRunning] = useState(false);
  const [logs, setLogs] = useState([]);
  const [results, setResults] = useState([]);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [grokStatus, setGrokStatus] = useState(null);
  const [grokStatusLoading, setGrokStatusLoading] = useState(false);
  const logRef = useRef(null);
  const eventSourceRef = useRef(null);

  const isGrokRegister = provider === "grok-cli";

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

  const refreshGrokStatus = useCallback(async () => {
    setGrokStatusLoading(true);
    try {
      const res = await fetch("/api/account-automation/grok-setup", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setGrokStatus(data);
        // Prefill email form from server (status + settings)
        if (data.emailConfig) {
          if (data.emailConfig.domain) setEmailDomain(data.emailConfig.domain);
          if (data.emailConfig.imapUser) setImapUser(data.emailConfig.imapUser);
          if (data.emailConfig.imapHost) setImapHost(data.emailConfig.imapHost);
          if (data.emailConfig.imapPort) setImapPort(data.emailConfig.imapPort);
          setHasSavedImapPass(Boolean(data.emailConfig.hasImapPass));
        }
      } else {
        setGrokStatus({ ready: false, instructions: [data.error || "Status check failed"] });
      }
    } catch (e) {
      setGrokStatus({ ready: false, instructions: [e.message] });
    } finally {
      setGrokStatusLoading(false);
    }
  }, []);

  const loadEmailFromSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      if (!res.ok) return;
      const s = await res.json();
      if (s.grokRegisterEmailDomain) setEmailDomain(s.grokRegisterEmailDomain);
      if (s.grokRegisterImapUser) setImapUser(s.grokRegisterImapUser);
      if (s.grokRegisterImapHost) setImapHost(s.grokRegisterImapHost || "imap.gmail.com");
      if (s.grokRegisterImapPort) setImapPort(s.grokRegisterImapPort || 993);
      setHasSavedImapPass(Boolean(s.hasGrokRegisterImapPass));
    } catch {
      /* ignore */
    }
  }, []);

  const saveEmailSettings = async () => {
    setEmailSaving(true);
    setEmailSaveMsg(null);
    setError(null);
    try {
      if (!emailDomain.trim() || !imapUser.trim()) {
        throw new Error("Domain and Gmail address are required.");
      }
      if (!imapPass.trim() && !hasSavedImapPass) {
        throw new Error("Gmail App Password is required (or keep a previously saved one).");
      }
      const body = {
        grokRegisterEmailDomain: emailDomain.trim(),
        grokRegisterImapUser: imapUser.trim(),
        grokRegisterImapHost: (imapHost || "imap.gmail.com").trim(),
        grokRegisterImapPort: Number(imapPort) || 993,
      };
      if (imapPass.trim()) {
        body.grokRegisterImapPass = imapPass.trim();
      }
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      setHasSavedImapPass(Boolean(data.hasGrokRegisterImapPass));
      setImapPass(""); // clear field after save (secret not re-shown)
      setEmailSaveMsg("Email / IMAP settings saved.");
      await refreshGrokStatus();
    } catch (e) {
      setError(e.message);
    } finally {
      setEmailSaving(false);
    }
  };

  useEffect(() => {
    return () => closeEventSource();
  }, [closeEventSource]);

  useEffect(() => {
    if (isGrokRegister) {
      refreshGrokStatus();
      loadEmailFromSettings();
    }
  }, [isGrokRegister, refreshGrokStatus, loadEmailFromSettings]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const appendLog = useCallback((entry) => {
    setLogs((prev) => [...prev, entry]);
  }, []);

  const attachSse = (runId, { onFinish } = {}) => {
    const es = new EventSource(
      `/api/account-automation/stream?runId=${encodeURIComponent(runId)}`,
    );
    eventSourceRef.current = es;
    // EventSource fires onerror when the stream closes after a normal `done` —
    // ignore that so the UI doesn't show a fake "SSE / automation failed".
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      closeEventSource();
      onFinish?.();
    };

    es.addEventListener("log", (e) => {
      try {
        appendLog(JSON.parse(e.data));
      } catch {
        appendLog({ level: "info", step: "raw", message: e.data });
      }
    });

    es.addEventListener("result", (e) => {
      try {
        setResults((prev) => [...prev, JSON.parse(e.data)]);
      } catch {
        // ignore
      }
    });

    es.addEventListener("done", (e) => {
      try {
        const data = JSON.parse(e.data);
        setSummary(data);
        if (data?.error && data.success === 0 && data.failed > 0) {
          // Soft failure summary — log once, not as SSE transport error
          appendLog({
            level: "warn",
            step: "done",
            message: data.error || `Finished with ${data.success || 0} success, ${data.failed || 0} failed`,
          });
        }
      } catch {
        // ignore
      }
      finish();
    });

    es.addEventListener("error", (e) => {
      if (finished) return;
      let message = "SSE connection failed";
      try {
        message = JSON.parse(e.data).message || message;
      } catch {
        // keep
      }
      // Only treat as hard error if we never received `done`
      appendLog({ level: "error", step: "sse", message });
      finish();
    });

    es.onerror = () => {
      // Normal close after done also hits onerror — ignore if already finished
      if (finished) return;
      appendLog({ level: "error", step: "sse", message: "SSE connection lost before run finished" });
      finish();
    };
  };

  const handleSetup = async () => {
    setSetupRunning(true);
    setError(null);
    setLogs([]);
    setResults([]);
    setSummary(null);
    closeEventSource();

    try {
      appendLog({
        level: "info",
        step: "setup",
        message:
          "Installing private Python environment + Chromium for Grok register… first time may take a few minutes. You do not need to use the terminal.",
      });

      const res = await fetch("/api/account-automation/grok-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (Array.isArray(data.logs)) {
        for (const log of data.logs) appendLog(log);
      }
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || "Setup failed");
      }
      appendLog({
        level: "success",
        step: "setup",
        message: data.status?.ready
          ? "Setup complete — ready to register accounts."
          : "Packages installed. Fill IMAP settings in config if the yellow hints below remain.",
      });
      setGrokStatus(data.status || null);
      await refreshGrokStatus();
    } catch (err) {
      setError(err.message);
      appendLog({ level: "error", step: "setup", message: err.message });
    } finally {
      setSetupRunning(false);
    }
  };

  const handleRun = async () => {
    if (isGrokRegister) {
      if (Number(count) < 1) {
        setError("Count must be at least 1.");
        return;
      }
    } else {
      const accounts = parseAccounts();
      if (accounts.length === 0) {
        setError("Enter at least one account in email:password format.");
        return;
      }
    }

    setRunning(true);
    setLogs([]);
    setResults([]);
    setSummary(null);
    setError(null);
    closeEventSource();

    try {
      if (isGrokRegister) {
        // Ensure latest form values are saved before run (so settings + env match)
        if (emailDomain.trim() && imapUser.trim() && (imapPass.trim() || hasSavedImapPass)) {
          const saveBody = {
            grokRegisterEmailDomain: emailDomain.trim(),
            grokRegisterImapUser: imapUser.trim(),
            grokRegisterImapHost: (imapHost || "imap.gmail.com").trim(),
            grokRegisterImapPort: Number(imapPort) || 993,
          };
          if (imapPass.trim()) saveBody.grokRegisterImapPass = imapPass.trim();
          await fetch("/api/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(saveBody),
          });
          if (imapPass.trim()) {
            setHasSavedImapPass(true);
            setImapPass("");
          }
        }
      }

      const body = isGrokRegister
        ? {
            provider: "grok-cli",
            count: Math.max(1, Number(count) || 1),
            concurrent: Math.max(1, Number(concurrent) || 1),
            display,
            stagger: Math.max(0, Number(stagger) || 0),
            headless: display === "headless",
            proxy: proxy.trim() || null,
            email: {
              domain: emailDomain.trim(),
              imapUser: imapUser.trim(),
              // empty pass → server uses saved settings password
              imapPass: imapPass.trim() || undefined,
              imapHost: (imapHost || "imap.gmail.com").trim(),
              imapPort: Number(imapPort) || 993,
            },
          }
        : {
            provider,
            accounts: parseAccounts(),
            headless,
            proxy: proxy.trim() || null,
          };

      const res = await fetch("/api/account-automation/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to start automation");
      }

      const runId = data.runId;
      if (!runId) throw new Error("No run ID returned from server");

      attachSse(runId, {
        onFinish: () => {
          setRunning(false);
          if (isGrokRegister) refreshGrokStatus();
        },
      });
    } catch (err) {
      setError(err.message);
      appendLog({ level: "error", step: "start", message: err.message });
      setRunning(false);
    }
  };

  const parsedCount = parseAccounts().length;
  const emailReady =
    emailDomain.trim() &&
    imapUser.trim() &&
    (imapPass.trim() || hasSavedImapPass);
  const canRun = isGrokRegister
    ? Number(count) >= 1 && Number(concurrent) >= 1 && emailReady
    : parsedCount > 0;

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
          Add Account
        </h1>
        <p className="text-sm text-text-muted">
          {isGrokRegister
            ? "Create new Grok CLI accounts and import them into 9router automatically."
            : "Bulk-automate provider logins with email and password credentials."}
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

          {isGrokRegister ? (
            <>
              {/* Setup / readiness */}
              <div
                className={`rounded-lg border px-3 py-3 text-sm ${
                  grokStatus?.ready
                    ? "border-green-500/30 bg-green-500/5"
                    : "border-amber-500/30 bg-amber-500/5"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium text-text-main">
                    {grokStatusLoading
                      ? "Checking environment…"
                      : grokStatus?.ready
                        ? "Environment ready"
                        : "Setup required (one-time)"}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={refreshGrokStatus}
                      disabled={grokStatusLoading || setupRunning}
                      icon="refresh"
                    >
                      Refresh
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleSetup}
                      disabled={setupRunning || running}
                      loading={setupRunning}
                      icon="download"
                    >
                      Setup environment
                    </Button>
                  </div>
                </div>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-text-muted">
                  {(grokStatus?.instructions || [
                    "Click Setup environment. 9router installs a private Python toolkit + browser for Grok register. You do not need to run Python yourself.",
                  ]).map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
                {grokStatus?.root && (
                  <p className="mt-2 text-[11px] text-text-muted break-all">
                    Bundle path: <code className="text-text-main">{grokStatus.root}</code>
                  </p>
                )}
                {grokStatus?.configHints?.length > 0 && (
                  <div className="mt-2 rounded-md bg-bg/80 px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400">
                    Config: {grokStatus.configHints.join(" · ")}
                  </div>
                )}
                {!grokStatus?.systemPython && grokStatus && (
                  <div className="mt-2 text-xs text-red-500">
                    Python 3.10+ not found on this computer. Install from{" "}
                    <a
                      className="underline"
                      href="https://www.python.org/downloads/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      python.org
                    </a>
                    , restart 9router, then click Setup again.
                  </div>
                )}
              </div>

              {/* Email / IMAP — all on this page */}
              <div className="rounded-lg border border-border-subtle bg-bg px-3 py-3 flex flex-col gap-3">
                <div>
                  <div className="text-sm font-medium text-text-main">
                    Email / IMAP (required)
                  </div>
                  <p className="text-xs text-text-muted mt-0.5">
                    Catch-all domain for new aliases + Gmail that receives them. Use a{" "}
                    <a
                      className="underline text-text-main"
                      href="https://myaccount.google.com/apppasswords"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Gmail App Password
                    </a>
                    , not your normal login password.
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input
                    label="Catch-all domain"
                    placeholder="yourdomain.com"
                    value={emailDomain}
                    onChange={(e) => setEmailDomain(e.target.value)}
                    hint="Cloudflare Email Routing catch-all → your Gmail"
                  />
                  <Input
                    label="Gmail address (IMAP)"
                    placeholder="you@gmail.com"
                    value={imapUser}
                    onChange={(e) => setImapUser(e.target.value)}
                  />
                  <Input
                    label={
                      hasSavedImapPass
                        ? "Gmail App Password (saved — leave blank to keep)"
                        : "Gmail App Password"
                    }
                    type="password"
                    placeholder={hasSavedImapPass ? "••••••••" : "xxxx xxxx xxxx xxxx"}
                    value={imapPass}
                    onChange={(e) => setImapPass(e.target.value)}
                    autoComplete="new-password"
                  />
                  <Input
                    label="IMAP host"
                    value={imapHost}
                    onChange={(e) => setImapHost(e.target.value)}
                    hint="Default imap.gmail.com"
                  />
                  <Input
                    label="IMAP port"
                    type="number"
                    value={imapPort}
                    onChange={(e) => setImapPort(e.target.value)}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={saveEmailSettings}
                    loading={emailSaving}
                    disabled={emailSaving || running}
                    icon="save"
                  >
                    Save email settings
                  </Button>
                  {emailSaveMsg && (
                    <span className="text-xs text-green-600">{emailSaveMsg}</span>
                  )}
                  {!emailReady && (
                    <span className="text-xs text-amber-600">
                      Fill domain + Gmail + app password before running.
                    </span>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Input
                  label="Total accounts"
                  type="number"
                  min={1}
                  max={500}
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  hint="How many Grok accounts to create."
                />
                <Input
                  label="Concurrent"
                  type="number"
                  min={1}
                  max={10}
                  value={concurrent}
                  onChange={(e) => setConcurrent(e.target.value)}
                  hint="Parallel browsers (e.g. 100 / 3 → 34+33+33)."
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium text-text-main">
                    Display mode
                  </label>
                  <Select
                    value={display}
                    onChange={(e) => setDisplay(e.target.value)}
                    options={DISPLAY_OPTIONS}
                    selectClassName="w-full"
                  />
                  <p className="text-xs text-text-muted">
                    Uses a dedicated Chromium for Testing — not your daily Google Chrome.
                  </p>
                </div>
                <Input
                  label="Stagger (seconds)"
                  type="number"
                  min={0}
                  max={120}
                  value={stagger}
                  onChange={(e) => setStagger(e.target.value)}
                  hint="Delay between starting each worker."
                />
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-text-main">Accounts</label>
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
          )}

          <Input
            label="Proxy (optional)"
            placeholder="http://user:pass@proxy:8080"
            value={proxy}
            onChange={(e) => setProxy(e.target.value)}
            hint={
              isGrokRegister
                ? "Passed to every farm worker."
                : "Used for all browser automation contexts in this run."
            }
          />

          {!isGrokRegister && (
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={headless}
                onChange={(e) => setHeadless(e.target.checked)}
                className="size-4 rounded border-border bg-surface-2 text-brand-500 focus:ring-brand-500/30"
              />
              <span className="text-sm text-text-main">
                Run browser in headless mode
              </span>
            </label>
          )}

          {error && (
            <div className="flex items-center gap-2 text-xs text-red-500">
              <span className="material-symbols-outlined text-[16px]">error</span>
              {error}
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button
              onClick={handleRun}
              disabled={running || setupRunning || !canRun}
              loading={running}
              icon="play_arrow"
            >
              {isGrokRegister ? "Run Grok Register" : "Run Automation"}
            </Button>
            {running && (
              <span className="text-sm text-text-muted animate-pulse">
                Automation running…
              </span>
            )}
          </div>
        </div>
      </Card>

      {(logs.length > 0 || running || setupRunning) && (
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
                    <span
                      className={`ml-2 ${LEVEL_COLORS[log.level] || "text-green-400"}`}
                    >
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
                  <span className="text-sm font-medium truncate">
                    {result.email || "—"}
                  </span>
                </div>
                {result.success ? (
                  <Badge variant="success" size="sm">
                    {isGrokRegister ? "Registered" : "Connected"}
                  </Badge>
                ) : (
                  <Badge variant="error" size="sm">
                    Failed
                  </Badge>
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
