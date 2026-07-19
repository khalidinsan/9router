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
  info: "text-sky-300",
  success: "text-emerald-400",
  warn: "text-amber-300",
  error: "text-red-400",
};

const PHASE_COLORS = {
  start: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  boot: "bg-zinc-500/15 text-zinc-300 ring-zinc-500/30",
  browser: "bg-zinc-500/15 text-zinc-300 ring-zinc-500/30",
  flow: "bg-indigo-500/15 text-indigo-300 ring-indigo-500/30",
  email: "bg-blue-500/15 text-blue-300 ring-blue-500/30",
  otp: "bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30",
  profile: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  turnstile: "bg-amber-500/15 text-amber-200 ring-amber-500/30",
  submit: "bg-orange-500/15 text-orange-300 ring-orange-500/30",
  settle: "bg-yellow-500/15 text-yellow-200 ring-yellow-500/30",
  sso: "bg-lime-500/15 text-lime-300 ring-lime-500/30",
  convert: "bg-teal-500/15 text-teal-300 ring-teal-500/30",
  push: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  created: "bg-emerald-500/20 text-emerald-300 ring-emerald-500/40",
  ok: "bg-emerald-500/20 text-emerald-300 ring-emerald-500/40",
  done: "bg-emerald-500/20 text-emerald-300 ring-emerald-500/40",
  fail: "bg-red-500/20 text-red-300 ring-red-500/40",
  import: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  setup: "bg-violet-500/15 text-violet-300 ring-violet-500/30",
  farm: "bg-zinc-500/10 text-zinc-300 ring-zinc-500/20",
  score: "bg-zinc-500/10 text-zinc-400 ring-zinc-500/20",
};

function phaseClass(step) {
  const k = String(step || "farm").toLowerCase();
  return PHASE_COLORS[k] || PHASE_COLORS.farm;
}

/** Format seconds → "1h 02m" / "12m 05s" / "45s" */
function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(r).padStart(2, "0")}s`;
  return `${r}s`;
}

/**
 * Throughput + ETA from success count (acc/min) and remaining work.
 * @param {number} ok - successful accounts so far
 * @param {number} fail - failed accounts
 * @param {number} total - planned total
 * @param {number} elapsedSec - seconds since run started
 */
function computeRateEta(ok, fail, total, elapsedSec) {
  const done = Math.max(0, (ok || 0) + (fail || 0));
  const tot = Math.max(0, Number(total) || 0);
  const elapsed = Math.max(0, elapsedSec || 0);
  // Prefer success rate for "acc/min"; fall back to done/min if no successes yet
  const rateBase = ok > 0 ? ok : done;
  const perMin = elapsed >= 8 && rateBase > 0 ? (rateBase / elapsed) * 60 : 0;
  const remaining = tot > 0 ? Math.max(0, tot - (ok > 0 ? ok : done)) : 0;
  // ETA: remaining successes / success-per-sec (or remaining done if only failures)
  let etaSec = null;
  if (perMin > 0 && tot > 0 && remaining > 0) {
    etaSec = (remaining / perMin) * 60;
  } else if (tot > 0 && remaining === 0 && done > 0) {
    etaSec = 0;
  }
  return {
    perMin,
    etaSec,
    elapsedSec: elapsed,
    remaining,
  };
}

/** Derive live worker cards from structured farm logs. */
function deriveWorkerBoard(logs, totalAccounts, concurrent) {
  const map = new Map();
  let globalOk = 0;
  let globalFail = 0;
  let lastGlobalTotal = Number(totalAccounts) || 0;

  for (const log of logs) {
    const p = log.progress;
    const wid = log.worker || p?.worker;
    if (!wid) continue;
    if (!map.has(wid)) {
      map.set(wid, {
        id: wid,
        phase: "—",
        message: "",
        email: "",
        localCur: 0,
        localShare: 0,
        ok: 0,
        fail: 0,
        globalIdx: null,
        level: "info",
      });
    }
    const w = map.get(wid);
    if (log.phase || log.step) w.phase = String(log.phase || log.step).toUpperCase();
    if (log.message) w.message = String(log.message).slice(0, 100);
    if (log.email) w.email = log.email;
    if (log.level) w.level = log.level;
    if (p) {
      if (p.localCur != null) w.localCur = p.localCur;
      if (p.localShare != null) w.localShare = p.localShare;
      if (p.ok != null) w.ok = p.ok;
      if (p.fail != null) w.fail = p.fail;
      if (p.globalIdx != null) w.globalIdx = p.globalIdx;
      if (p.globalTotal != null) lastGlobalTotal = p.globalTotal;
    }
  }

  const workers = Array.from(map.values()).sort(
    (a, b) => Number(a.id) - Number(b.id) || String(a.id).localeCompare(String(b.id))
  );
  for (const w of workers) {
    globalOk += Number(w.ok) || 0;
    globalFail += Number(w.fail) || 0;
  }

  // Prefer import/results counts when higher (saved to DB)
  return {
    workers,
    globalOk,
    globalFail,
    globalTotal: lastGlobalTotal || Number(totalAccounts) || 0,
    concurrent: Number(concurrent) || workers.length || 1,
  };
}

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
  const [logFilter, setLogFilter] = useState("all"); // all | W1 | W2 | …
  const [logAutoScroll, setLogAutoScroll] = useState(true);
  const [activeRunId, setActiveRunId] = useState(null);
  const [stopping, setStopping] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState(null); // ms epoch
  const [nowTick, setNowTick] = useState(() => Date.now());
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
    if (logAutoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, logAutoScroll]);

  // Live clock for elapsed / rate / ETA while running
  useEffect(() => {
    if (!running && !stopping) return undefined;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running, stopping]);

  const appendLog = useCallback((entry) => {
    setLogs((prev) => {
      const next = [
        ...prev,
        {
          time: entry.time || new Date().toISOString(),
          ...entry,
        },
      ];
      // cap UI log buffer
      return next.length > 1200 ? next.slice(-1200) : next;
    });
  }, []);

  const workerBoard = isGrokRegister
    ? deriveWorkerBoard(logs, count, concurrent)
    : null;
  const savedOk = results.filter((r) => r.success).length;
  const progressOk = Math.max(workerBoard?.globalOk || 0, savedOk, summary?.success || 0);
  const progressFail = Math.max(workerBoard?.globalFail || 0, summary?.failed || 0);
  const progressTotal = Number(count) || workerBoard?.globalTotal || 0;
  const progressDone = Math.min(
    progressTotal || progressOk + progressFail,
    progressOk + progressFail
  );
  const progressPct =
    progressTotal > 0 ? Math.min(100, Math.round((progressDone / progressTotal) * 100)) : 0;

  const elapsedSec = runStartedAt
    ? Math.max(0, (nowTick - runStartedAt) / 1000)
    : 0;
  const { perMin: accPerMin, etaSec } = computeRateEta(
    progressOk,
    progressFail,
    progressTotal,
    elapsedSec
  );

  const filteredLogs =
    !isGrokRegister || logFilter === "all"
      ? logs
      : logs.filter(
          (l) =>
            String(l.worker || l.progress?.worker || "") === String(logFilter).replace(/^W/i, "") ||
            String(l.worker || "") === logFilter ||
            !l.worker
        );

  const workerIds = workerBoard?.workers?.map((w) => w.id) || [];

  const handleForceStop = async () => {
    if (!activeRunId || stopping) return;
    setStopping(true);
    appendLog({
      level: "warn",
      step: "stop",
      message: "Force stop… killing farm + Chromium",
    });
    try {
      const res = await fetch("/api/account-automation/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: activeRunId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Stop failed");
      }
      appendLog({
        level: "warn",
        step: "stop",
        message: data.message || "Stop signal sent",
      });
    } catch (e) {
      setError(e.message);
      appendLog({ level: "error", step: "stop", message: e.message });
      setStopping(false);
    }
  };

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
      setStopping(false);
      setActiveRunId(null);
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
        if (data?.stopped || data?.status === "stopped") {
          appendLog({
            level: "warn",
            step: "stop",
            message: `Stopped — ✓${data.success || 0} saved before stop`,
          });
        } else if (data?.error && data.success === 0 && data.failed > 0) {
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
    setStopping(false);
    setLogs([]);
    setResults([]);
    setSummary(null);
    setError(null);
    setLogFilter("all");
    setRunStartedAt(Date.now());
    setActiveRunId(null);
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
      setActiveRunId(runId);

      attachSse(runId, {
        onFinish: () => {
          setRunning(false);
          setStopping(false);
          if (isGrokRegister) refreshGrokStatus();
        },
      });
    } catch (err) {
      setError(err.message);
      appendLog({ level: "error", step: "start", message: err.message });
      setRunning(false);
      setStopping(false);
      setActiveRunId(null);
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

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={handleRun}
              disabled={running || setupRunning || !canRun || stopping}
              loading={running && !stopping}
              icon="play_arrow"
            >
              {isGrokRegister ? "Run Grok Register" : "Run Automation"}
            </Button>
            {running && (
              <Button
                variant="secondary"
                onClick={handleForceStop}
                disabled={stopping || !activeRunId}
                loading={stopping}
                icon="stop_circle"
                className="!border-red-500/40 !text-red-500 hover:!bg-red-500/10"
              >
                {stopping ? "Stopping…" : "Force Stop"}
              </Button>
            )}
            {running && (
              <span className="text-sm text-text-muted animate-pulse">
                {stopping ? "Force stopping workers + Chrome…" : "Automation running…"}
              </span>
            )}
          </div>
        </div>
      </Card>

      {/* ── Live progress (Grok) ── */}
      {isGrokRegister && (logs.length > 0 || running || results.length > 0 || summary) && (
        <Card title="Live progress" icon="monitoring">
          <div className="flex flex-col gap-4">
            {/* Global bar */}
            <div className="rounded-xl border border-border-subtle bg-bg/60 px-4 py-3">
              <div className="flex flex-wrap items-end justify-between gap-2 mb-2">
                <div>
                  <div className="text-xs text-text-muted uppercase tracking-wide">
                    Pool
                  </div>
                  <div className="text-lg font-semibold tabular-nums text-text-main">
                    {progressDone}
                    <span className="text-text-muted font-normal">
                      /{progressTotal || "?"}
                    </span>
                    <span className="ml-2 text-sm font-normal text-text-muted">
                      ({progressPct}%)
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
                  <span className="text-emerald-500">
                    ✓ <strong>{progressOk}</strong>
                  </span>
                  <span className="text-red-500">
                    ✗ <strong>{progressFail}</strong>
                  </span>
                  <span className="text-text-muted">
                    workers{" "}
                    <strong className="text-text-main">
                      {workerBoard?.workers?.length || concurrent}
                    </strong>
                  </span>
                  {running && (
                    <span className="text-sky-400 animate-pulse text-xs self-center">
                      {stopping ? "stopping…" : "running…"}
                    </span>
                  )}
                </div>
              </div>
              <div className="h-2.5 w-full rounded-full bg-surface-2 overflow-hidden mb-3">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all duration-500"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              {/* Rate + ETA */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs sm:text-sm">
                <div className="rounded-lg bg-surface-2/80 px-2.5 py-1.5">
                  <div className="text-[10px] uppercase text-text-muted tracking-wide">
                    Elapsed
                  </div>
                  <div className="font-semibold tabular-nums text-text-main">
                    {formatDuration(elapsedSec)}
                  </div>
                </div>
                <div className="rounded-lg bg-surface-2/80 px-2.5 py-1.5">
                  <div className="text-[10px] uppercase text-text-muted tracking-wide">
                    Acc / min
                  </div>
                  <div className="font-semibold tabular-nums text-sky-400">
                    {accPerMin > 0 ? `~${accPerMin.toFixed(1)}` : "—"}
                  </div>
                </div>
                <div className="rounded-lg bg-surface-2/80 px-2.5 py-1.5">
                  <div className="text-[10px] uppercase text-text-muted tracking-wide">
                    ETA left
                  </div>
                  <div className="font-semibold tabular-nums text-amber-400">
                    {etaSec == null
                      ? progressOk === 0 && progressDone === 0
                        ? "…"
                        : "—"
                      : etaSec <= 0
                        ? "done"
                        : `~${formatDuration(etaSec)}`}
                  </div>
                </div>
                <div className="rounded-lg bg-surface-2/80 px-2.5 py-1.5">
                  <div className="text-[10px] uppercase text-text-muted tracking-wide">
                    Finish ~
                  </div>
                  <div className="font-semibold tabular-nums text-text-main">
                    {etaSec != null && etaSec > 0 && runStartedAt
                      ? new Date(Date.now() + etaSec * 1000).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "—"}
                  </div>
                </div>
              </div>
            </div>

            {/* Worker cards */}
            {workerBoard?.workers?.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                {workerBoard.workers.map((w) => (
                  <button
                    type="button"
                    key={w.id}
                    onClick={() =>
                      setLogFilter((prev) =>
                        prev === String(w.id) || prev === `W${w.id}`
                          ? "all"
                          : String(w.id)
                      )
                    }
                    className={`text-left rounded-xl border px-3 py-2.5 transition-colors ${
                      logFilter === String(w.id) || logFilter === `W${w.id}`
                        ? "border-brand-500/50 bg-brand-500/10"
                        : "border-border-subtle bg-bg hover:border-border"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-sm font-semibold text-text-main">
                        W{w.id}
                      </span>
                      <span
                        className={`text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded ring-1 ${phaseClass(
                          w.phase
                        )}`}
                      >
                        {w.phase}
                      </span>
                    </div>
                    <div className="text-xs text-text-muted tabular-nums mb-1">
                      {w.localCur || 0}/{w.localShare || "?"}
                      {w.globalIdx != null && (
                        <span className="ml-1.5">· #{w.globalIdx}</span>
                      )}
                      <span className="ml-1.5 text-emerald-500">✓{w.ok}</span>
                      <span className="ml-1 text-red-400">✗{w.fail}</span>
                    </div>
                    {w.email && (
                      <div className="text-[11px] font-mono text-text-main truncate mb-0.5">
                        {w.email}
                      </div>
                    )}
                    <div className="text-[11px] text-text-muted line-clamp-2 leading-snug">
                      {w.message || "—"}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}

      {(logs.length > 0 || running || setupRunning) && (
        <Card
          title={isGrokRegister ? "Activity log" : "Progress Log"}
          icon="terminal"
        >
          {isGrokRegister && (
            <div className="flex flex-wrap items-center gap-2 px-1 pb-3 border-b border-border-subtle mb-0">
              <span className="text-xs text-text-muted">Filter:</span>
              <button
                type="button"
                onClick={() => setLogFilter("all")}
                className={`text-xs px-2 py-1 rounded-md border ${
                  logFilter === "all"
                    ? "border-brand-500/50 bg-brand-500/10 text-text-main"
                    : "border-border-subtle text-text-muted hover:text-text-main"
                }`}
              >
                All
              </button>
              {workerIds.map((id) => (
                <button
                  type="button"
                  key={id}
                  onClick={() => setLogFilter(String(id))}
                  className={`text-xs px-2 py-1 rounded-md border tabular-nums ${
                    logFilter === String(id)
                      ? "border-brand-500/50 bg-brand-500/10 text-text-main"
                      : "border-border-subtle text-text-muted hover:text-text-main"
                  }`}
                >
                  W{id}
                </button>
              ))}
              <label className="ml-auto flex items-center gap-1.5 text-xs text-text-muted cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={logAutoScroll}
                  onChange={(e) => setLogAutoScroll(e.target.checked)}
                  className="size-3.5 rounded border-border"
                />
                Auto-scroll
              </label>
              <span className="text-[11px] text-text-muted tabular-nums">
                {filteredLogs.length} lines
              </span>
            </div>
          )}
          <div
            ref={logRef}
            className="bg-zinc-950 rounded-b-lg p-3 sm:p-4 text-[11px] sm:text-xs font-mono h-96 overflow-y-auto leading-relaxed"
          >
            {filteredLogs.length === 0 ? (
              <span className="text-zinc-500">Waiting for logs…</span>
            ) : (
              <div className="space-y-0.5">
                {filteredLogs.map((log, i) => {
                  const step = log.phase || log.step || "farm";
                  const wid = log.worker || log.progress?.worker;
                  return (
                    <div
                      key={i}
                      className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 break-words border-b border-white/[0.03] py-0.5"
                    >
                      <span className="text-zinc-500 tabular-nums shrink-0 w-[4.5rem]">
                        {log.time
                          ? new Date(log.time).toLocaleTimeString()
                          : ""}
                      </span>
                      {wid && (
                        <span className="text-sky-400/90 shrink-0 w-7 font-semibold">
                          W{wid}
                        </span>
                      )}
                      <span
                        className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ring-1 ${phaseClass(
                          step
                        )}`}
                      >
                        {String(step).slice(0, 12)}
                      </span>
                      <span
                        className={`min-w-0 flex-1 ${
                          LEVEL_COLORS[log.level] || "text-zinc-200"
                        }`}
                      >
                        {log.message}
                      </span>
                      {log.email && (
                        <span className="text-zinc-500 shrink-0 max-w-[12rem] truncate">
                          {log.email}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>
      )}

      {results.length > 0 && (
        <Card title="Saved to 9router" icon="checklist">
          <div className="overflow-x-auto rounded-lg border border-border-subtle">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle bg-bg/80 text-left text-xs text-text-muted">
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Email / name</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {results.map((result, i) => (
                  <tr
                    key={i}
                    className="border-b border-border-subtle/70 last:border-0 hover:bg-bg/50"
                  >
                    <td className="px-3 py-2 text-text-muted tabular-nums w-10">
                      {i + 1}
                    </td>
                    <td className="px-3 py-2 font-medium text-text-main font-mono text-xs sm:text-sm">
                      {result.email || "—"}
                    </td>
                    <td className="px-3 py-2">
                      {result.success ? (
                        <Badge variant="success" size="sm">
                          {isGrokRegister ? "Registered" : "Connected"}
                        </Badge>
                      ) : (
                        <Badge variant="error" size="sm">
                          Failed
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-text-muted max-w-xs truncate">
                      {result.message ||
                        (result.connectionId
                          ? `id=${result.connectionId}`
                          : "—")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {summary && (
        <Card title="Summary" icon="summarize">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="rounded-lg border border-border-subtle bg-bg px-3 py-2">
              <div className="text-[11px] text-text-muted uppercase">Total</div>
              <div className="text-xl font-semibold tabular-nums text-text-main">
                {summary.total}
              </div>
            </div>
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
              <div className="text-[11px] text-emerald-600/80 uppercase">Success</div>
              <div className="text-xl font-semibold tabular-nums text-emerald-500">
                {summary.success}
              </div>
            </div>
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2">
              <div className="text-[11px] text-red-500/80 uppercase">Failed</div>
              <div className="text-xl font-semibold tabular-nums text-red-500">
                {summary.failed}
              </div>
            </div>
            <div className="rounded-lg border border-border-subtle bg-bg px-3 py-2">
              <div className="text-[11px] text-text-muted uppercase">Saved</div>
              <div className="text-xl font-semibold tabular-nums text-text-main">
                {savedOk}
              </div>
            </div>
            <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2">
              <div className="text-[11px] text-sky-600/80 uppercase">Acc / min</div>
              <div className="text-xl font-semibold tabular-nums text-sky-400">
                {elapsedSec > 0 && progressOk > 0
                  ? `~${((progressOk / elapsedSec) * 60).toFixed(1)}`
                  : "—"}
              </div>
            </div>
            <div className="rounded-lg border border-border-subtle bg-bg px-3 py-2">
              <div className="text-[11px] text-text-muted uppercase">
                {summary.stopped || summary.status === "stopped" ? "Stopped after" : "Duration"}
              </div>
              <div className="text-xl font-semibold tabular-nums text-text-main">
                {formatDuration(elapsedSec)}
              </div>
            </div>
          </div>
          {(summary.stopped || summary.status === "stopped") && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              Run was force-stopped. Partial results above were already saved.
            </p>
          )}
          {Array.isArray(summary.errors) && summary.errors.length > 0 && (
            <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 space-y-1">
              {summary.errors.slice(0, 5).map((err, i) => (
                <div key={i}>• {err}</div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
