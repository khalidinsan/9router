/**
 * Grok CLI register — runs the bundled Python farm under tools/grok-register.
 *
 * Auto-detects project path, venv Python, and can run setup_env.py so end users
 * never need to know Python is involved (UI shows Setup + clear status).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fileExists(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirExists(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 9router project root (folder that contains package.json + tools/). */
export function resolveNinerouterRoot() {
  const candidates = [
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(__dirname, "../../../../.."),
    path.resolve(__dirname, "../../../../../.."),
  ];
  for (const c of candidates) {
    const abs = path.resolve(c);
    if (fileExists(path.join(abs, "package.json")) && dirExists(path.join(abs, "tools"))) {
      return abs;
    }
    if (fileExists(path.join(abs, "package.json")) && dirExists(path.join(abs, "src"))) {
      // tools may not exist yet in odd layouts — still accept
      return abs;
    }
  }
  return process.cwd();
}

/**
 * Path to bundled farm (preferred) or external override.
 */
export function resolveGrokRegisterRoot() {
  if (process.env.GROK_REGISTER_PATH) {
    const abs = path.resolve(process.env.GROK_REGISTER_PATH);
    if (fileExists(path.join(abs, "pool.py")) || fileExists(path.join(abs, "run_pool.py"))) {
      return abs;
    }
  }

  const ninerouter = resolveNinerouterRoot();
  const bundled = path.join(ninerouter, "tools", "grok-register");
  if (fileExists(path.join(bundled, "pool.py"))) {
    return bundled;
  }

  // Dev fallback: sibling repo
  const sibling = path.resolve(ninerouter, "..", "grok-register");
  if (fileExists(path.join(sibling, "pool.py")) || fileExists(path.join(sibling, "run_pool.py"))) {
    return sibling;
  }

  return bundled; // expected path even if incomplete (status will say missing)
}

function venvPython(root) {
  if (process.platform === "win32") {
    return path.join(root, ".venv", "Scripts", "python.exe");
  }
  return path.join(root, ".venv", "bin", "python");
}

import { spawnSync } from "node:child_process";

export function detectSystemPython() {
  const candidates =
    process.platform === "win32"
      ? [
          ["py", ["-3"]],
          ["python"],
          ["python3"],
        ]
      : [["python3"], ["python"]];

  for (const [cmd, extra = []] of candidates) {
    try {
      const r = spawnSync(cmd, [...extra, "--version"], {
        encoding: "utf8",
        timeout: 5000,
      });
      if (r.status === 0) {
        const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
        // Prefer 3.10–3.13; still return 3.14 with a warning flag
        const m = out.match(/Python\s+(\d+)\.(\d+)/i);
        const major = m ? Number(m[1]) : 0;
        const minor = m ? Number(m[2]) : 0;
        if (major === 3 && minor >= 10) {
          return {
            command: cmd,
            prefixArgs: extra,
            version: `${major}.${minor}`,
            ok: true,
            warn: minor >= 14 ? "Python 3.14+ may have TLS edge cases; 3.10–3.13 preferred." : null,
          };
        }
      }
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Readiness report for UI / API (async — loads 9router settings for IMAP).
 */
export async function getGrokRegisterStatus() {
  const root = resolveGrokRegisterRoot();
  const poolScript = fileExists(path.join(root, "pool.py"))
    ? path.join(root, "pool.py")
    : fileExists(path.join(root, "run_pool.py"))
      ? path.join(root, "run_pool.py")
      : null;
  const setupScript = path.join(root, "setup_env.py");
  const py = venvPython(root);
  const hasVenv = fileExists(py);
  const hasConfig = fileExists(path.join(root, "config.json"));
  const systemPython = detectSystemPython();

  // Email/IMAP: prefer 9router Settings (filled on Add Account page)
  let configOk = false;
  let configHints = [];
  let emailFromSettings = {
    domain: "",
    imapUser: "",
    imapPass: "",
    imapHost: "imap.gmail.com",
    imapPort: 993,
  };
  try {
    const { getSettings } = await import("../../../../src/lib/db/repos/settingsRepo.js");
    const s = await getSettings();
    emailFromSettings = {
      domain: (s.grokRegisterEmailDomain || "").trim(),
      imapUser: (s.grokRegisterImapUser || "").trim(),
      imapPass: (s.grokRegisterImapPass || "").trim(),
      imapHost: (s.grokRegisterImapHost || "imap.gmail.com").trim() || "imap.gmail.com",
      imapPort: Number(s.grokRegisterImapPort) || 993,
    };
  } catch {
    /* outside Next / tests */
  }

  if (emailFromSettings.domain && emailFromSettings.imapUser && emailFromSettings.imapPass) {
    configOk = true;
  } else if (hasConfig) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
      const email = cfg.email || {};
      if (email.domain && email.imap_user && email.imap_pass) {
        configOk = true;
        emailFromSettings = {
          domain: String(email.domain).trim(),
          imapUser: String(email.imap_user).trim(),
          imapPass: String(email.imap_pass).trim(),
          imapHost: String(email.imap_host || "imap.gmail.com").trim(),
          imapPort: Number(email.imap_port) || 993,
        };
      }
    } catch {
      /* ignore */
    }
  }

  if (!configOk) {
    if (!emailFromSettings.domain) configHints.push("Catch-all domain is empty");
    if (!emailFromSettings.imapUser) configHints.push("IMAP Gmail is empty");
    if (!emailFromSettings.imapPass) configHints.push("IMAP app password is empty");
    configHints.push("Fill the Email / IMAP fields on this page and click Save email settings");
  }

  let browserOk = false;
  if (hasVenv) {
    try {
      const r = spawnSync(
        py,
        [
          "-c",
          "import glob, os; home=os.path.expanduser('~'); roots=[os.path.join(home,'Library/Caches/ms-playwright'),os.path.join(home,'.cache/ms-playwright')]; print(any(glob.glob(os.path.join(r,'chromium-*')) for r in roots if os.path.isdir(r)))",
        ],
        { encoding: "utf8", timeout: 15000 },
      );
      browserOk = (r.stdout || "").trim().toLowerCase().includes("true");
    } catch {
      browserOk = false;
    }
  }

  let depsOk = false;
  if (hasVenv) {
    try {
      const r = spawnSync(py, ["-c", "import DrissionPage; import playwright; print('ok')"], {
        encoding: "utf8",
        timeout: 15000,
      });
      depsOk = r.status === 0 && (r.stdout || "").includes("ok");
    } catch {
      depsOk = false;
    }
  }

  const ready = Boolean(poolScript && hasVenv && depsOk && browserOk && configOk);
  const needsSetup = !hasVenv || !depsOk || !browserOk;

  const instructions = [];
  if (!systemPython && needsSetup) {
    instructions.push(
      "Install Python 3.10–3.13 from https://www.python.org/downloads/ then click Setup environment.",
    );
  } else if (needsSetup) {
    instructions.push(
      "Click “Setup environment” once. Installs a private Python toolkit + Chromium (not your daily Chrome).",
    );
  }
  if (!configOk) {
    instructions.push(
      "Fill Catch-all domain + Gmail + App Password in the Email / IMAP section below, then Save.",
    );
  }
  if (ready) {
    instructions.push("Ready. Set Total accounts + Concurrent, then Run Grok Register.");
  }

  return {
    ready,
    needsSetup,
    root,
    poolScript,
    setupScript: fileExists(setupScript) ? setupScript : null,
    venvPython: hasVenv ? py : null,
    systemPython,
    hasConfig,
    configOk,
    configHints,
    depsOk,
    browserOk,
    instructions,
    // safe fields for UI prefill (never include raw pass)
    emailConfig: {
      domain: emailFromSettings.domain,
      imapUser: emailFromSettings.imapUser,
      imapHost: emailFromSettings.imapHost,
      imapPort: emailFromSettings.imapPort,
      hasImapPass: Boolean(emailFromSettings.imapPass),
    },
  };
}

function spawnAndStream(command, args, { cwd, env, onLog, label = "setup" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pipe = (stream, isErr) => {
      const rl = readline.createInterface({ input: stream });
      rl.on("line", (line) => {
        const text = String(line || "");
        if (!text.trim()) return;
        onLog?.({
          level: isErr || /error|ERROR|failed/i.test(text) ? "error" : /warn/i.test(text) ? "warn" : "info",
          step: label,
          message: text,
        });
      });
    };
    pipe(child.stdout, false);
    pipe(child.stderr, true);

    child.on("error", (err) => {
      onLog?.({ level: "error", step: label, message: err.message });
      reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) resolve(code);
      else reject(new Error(`${label} exited with code ${code}`));
    });
  });
}

/**
 * Run setup_env.py (create venv, pip install, playwright chromium).
 */
export async function setupGrokRegister({ onLog = () => {} } = {}) {
  const status = await getGrokRegisterStatus();
  const root = status.root;

  if (!status.poolScript && !fileExists(path.join(root, "pool.py"))) {
    const msg = `Grok register bundle missing at ${root}. Reinstall 9router or set GROK_REGISTER_PATH.`;
    onLog({ level: "error", step: "setup", message: msg });
    throw new Error(msg);
  }

  const sys = status.systemPython;
  if (!sys) {
    const msg =
      "Python 3.10+ was not found on this machine. Install Python from https://www.python.org/downloads/ (check “Add python.exe to PATH” on Windows), restart 9router, then click Setup again.";
    onLog({ level: "error", step: "setup", message: msg });
    throw new Error(msg);
  }

  onLog({
    level: "info",
    step: "setup",
    message: `Using system Python ${sys.version} (${sys.command})`,
  });
  if (sys.warn) {
    onLog({ level: "warn", step: "setup", message: sys.warn });
  }

  const setupPy = path.join(root, "setup_env.py");
  if (!fileExists(setupPy)) {
    throw new Error(`setup_env.py missing in ${root}`);
  }

  const cmd = sys.command;
  const args = [...(sys.prefixArgs || []), setupPy];
  await spawnAndStream(cmd, args, { cwd: root, onLog, label: "setup" });

  const after = await getGrokRegisterStatus();
  if (!after.venvPython) {
    throw new Error("Setup finished but venv Python was not created.");
  }
  onLog({
    level: "success",
    step: "setup",
    message: after.ready
      ? "Environment ready. You can run Grok Register."
      : `Venv ready. Still need email/IMAP on Add Account: ${after.configHints.join("; ") || "check form"}`,
  });
  return after;
}

const IMPORT_MARKER = "@@GROK_CLI_IMPORT@@";

/**
 * Structured slog from farm.py, e.g.:
 * 14:24:01 [W1 1/40 · #1/200 · remW 40 · ✓0 ✗0] EMAIL          alias=...
 */
const SLOG_RE =
  /^(?<ts>\d{2}:\d{2}:\d{2})\s+\[W(?<wid>[^\s·\]]+)(?:\s+(?<cur>\d+)\/(?<share>\d+))?(?:\s*·\s*#(?<gidx>\d+)\/(?<gtotal>\d+))?(?:\s*·\s*remW\s+(?<remw>\d+))?(?:\s*·\s*✓(?<ok>\d+)\s*✗(?<fail>\d+))?\]\s+(?<phase>\S+)\s+(?<msg>.*)$/;

function parseFarmLogLine(line) {
  // In-process import payload from push_9router_grok_cli.py
  if (line.includes(IMPORT_MARKER)) {
    const start = line.indexOf(IMPORT_MARKER) + IMPORT_MARKER.length;
    const end = line.indexOf(IMPORT_MARKER, start);
    if (end > start) {
      try {
        const payload = JSON.parse(line.slice(start, end));
        return { type: "import", payload };
      } catch {
        return { type: "log" };
      }
    }
  }

  const slog = line.match(SLOG_RE);
  if (slog?.groups) {
    const g = slog.groups;
    const phase = (g.phase || "RUN").trim().toUpperCase();
    const msg = (g.msg || "").trim();
    const emailMatch = msg.match(/(?:alias|email)=([^\s]+)/i);
    let level = "info";
    if (phase === "FAIL" || phase === "STOP" || /error|failed/i.test(msg)) level = "error";
    else if (phase === "OK" || phase === "CREATED" || phase === "DONE" || phase === "PUSH")
      level = "success";
    else if (phase === "SUBMIT" || /warn|still on form|retry/i.test(msg)) level = "warn";

    return {
      type: "slog",
      worker: String(g.wid || ""),
      phase,
      message: msg,
      email: emailMatch ? emailMatch[1] : null,
      level,
      progress: {
        localCur: g.cur ? Number(g.cur) : null,
        localShare: g.share ? Number(g.share) : null,
        globalIdx: g.gidx ? Number(g.gidx) : null,
        globalTotal: g.gtotal ? Number(g.gtotal) : null,
        remW: g.remw ? Number(g.remw) : null,
        ok: g.ok != null ? Number(g.ok) : null,
        fail: g.fail != null ? Number(g.fail) : null,
      },
    };
  }

  // legacy formats
  const created = line.match(/CREATED\s*\|\s*email=([^\s|]+)/i);
  if (created) return { type: "created", email: created[1].trim() };
  const created2 = line.match(/\[\w[^\]]*\]\s+CREATED\s+email=(\S+)/i);
  if (created2) return { type: "created", email: created2[1].trim() };
  const done = line.match(/Round complete,\s*email:\s*(\S+)/i);
  if (done) return { type: "created", email: done[1].trim() };
  return { type: "log" };
}

/**
 * Save grok-cli connection directly in this 9router process (no HTTP loopback).
 */
export async function importGrokCliInProcess(payload) {
  const { createProviderConnection } = await import(
    "../../../../src/lib/db/repos/connectionsRepo.js"
  );

  const accessToken = String(payload.accessToken || "").trim();
  if (!accessToken) {
    throw new Error("import payload missing accessToken");
  }

  let email = payload.email || null;
  let userId = payload.userId || null;
  let displayName = payload.displayName || null;

  try {
    const claimSource = payload.idToken || accessToken;
    const parts = String(claimSource).split(".");
    if (parts.length >= 2) {
      const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      const claims = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
      if (!email) email = claims.email || claims.preferred_username || null;
      if (!userId) userId = claims.sub || claims.principal_id || null;
      if (!displayName) {
        const joined = [claims.given_name, claims.family_name].filter(Boolean).join(" ").trim();
        if (joined) displayName = joined;
      }
    }
  } catch {
    // ignore jwt parse
  }

  let expiresAt = null;
  if (typeof payload.expiresAt === "string" && payload.expiresAt.trim()) {
    expiresAt = payload.expiresAt.trim();
  } else if (typeof payload.expiresIn === "number" && payload.expiresIn > 0) {
    expiresAt = new Date(Date.now() + payload.expiresIn * 1000).toISOString();
  }

  const scope =
    (typeof payload.scope === "string" && payload.scope.trim()) ||
    "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";

  const connectionName =
    (typeof payload.name === "string" && payload.name.trim()) ||
    email ||
    displayName ||
    "Grok CLI";

  const connection = await createProviderConnection({
    provider: "grok-cli",
    authType: "oauth",
    name: connectionName,
    email: email || null,
    displayName: displayName || connectionName,
    accessToken,
    refreshToken: payload.refreshToken || null,
    expiresAt,
    expiresIn: typeof payload.expiresIn === "number" ? payload.expiresIn : undefined,
    scope,
    testStatus: "active",
    providerSpecificData: {
      authMethod: "device_code",
      idToken: payload.idToken || null,
      email: email || null,
      userId: userId || null,
    },
  });

  return connection;
}

/**
 * Run bundled farm pool.
 */
export async function runGrokRegister(opts = {}) {
  const {
    count = 1,
    concurrent = 1,
    headless = false,
    proxy = null,
    display: displayOpt = null,
    stagger = 15,
    autoSetup = true,
    onLog = () => {},
    onResult = () => {},
    onDone = () => {},
  } = opts;

  let status = await getGrokRegisterStatus();

  if (status.needsSetup && autoSetup) {
    onLog({
      level: "info",
      step: "setup",
      message: "Environment not ready — running automatic setup (first time may take a few minutes)…",
    });
    try {
      status = await setupGrokRegister({ onLog });
    } catch (e) {
      const summary = {
        total: count,
        success: 0,
        failed: count,
        errors: [e.message],
      };
      onDone(summary);
      throw e;
    }
  }

  status = await getGrokRegisterStatus();
  if (!status.venvPython || !status.poolScript) {
    const msg =
      status.instructions?.join(" ") ||
      "Grok register is not set up. Open Add Account → Grok CLI → Setup environment.";
    onLog({ level: "error", step: "setup", message: msg });
    const summary = { total: count, success: 0, failed: count, errors: [msg] };
    onDone(summary);
    throw new Error(msg);
  }

  // Resolve IMAP: explicit opts.email > 9router settings > status.emailConfig
  let emailCfg = opts.email || null;
  if (!emailCfg?.domain || !emailCfg?.imapUser || !emailCfg?.imapPass) {
    try {
      const { getSettings } = await import("../../../../src/lib/db/repos/settingsRepo.js");
      const s = await getSettings();
      emailCfg = {
        domain: (s.grokRegisterEmailDomain || "").trim(),
        imapUser: (s.grokRegisterImapUser || "").trim(),
        imapPass: (s.grokRegisterImapPass || "").trim(),
        imapHost: (s.grokRegisterImapHost || "imap.gmail.com").trim(),
        imapPort: Number(s.grokRegisterImapPort) || 993,
      };
    } catch {
      emailCfg = emailCfg || {};
    }
  }

  if (!emailCfg?.domain || !emailCfg?.imapUser || !emailCfg?.imapPass) {
    const msg =
      "Email/IMAP incomplete. Fill Catch-all domain, Gmail, and App Password on the Add Account page, then Save.";
    onLog({ level: "error", step: "config", message: msg });
    const summary = { total: count, success: 0, failed: count, errors: [msg] };
    onDone(summary);
    throw new Error(msg);
  }

  const root = status.root;
  const python = status.venvPython;
  const poolScript = status.poolScript;
  let display = displayOpt;
  if (!display) {
    display = headless ? "headless" : process.platform === "darwin" ? "offscreen" : "headed";
  }

  const args = [
    poolScript,
    "--count",
    String(Math.max(0, Number(count) || 0)),
    "--concurrent",
    String(Math.max(1, Number(concurrent) || 1)),
    "--display",
    display,
    "--stagger",
    String(Math.max(0, Number(stagger) || 0)),
  ];
  if (proxy && String(proxy).trim()) {
    args.push("--proxy", String(proxy).trim());
  }

  onLog({
    level: "info",
    step: "start",
    message: `Starting farm: ${count} accounts, concurrent ${concurrent}, display=${display}`,
  });
  onLog({
    level: "info",
    step: "start",
    message: `IMAP ${emailCfg.imapUser} @ ${emailCfg.imapHost} domain=${emailCfg.domain}`,
  });

  const summary = {
    total: Math.max(0, Number(count) || 0),
    success: 0,
    failed: 0,
    errors: [],
  };
  const created = new Set();

  await new Promise((resolve, reject) => {
    const child = spawn(python, args, {
      cwd: root,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        NINEROUTER_IMPORT_MODE: "direct",
        // Email/IMAP from Add Account UI (overrides farm config.json)
        EMAIL_DOMAIN: String(emailCfg.domain || ""),
        IMAP_USER: String(emailCfg.imapUser || ""),
        IMAP_PASS: String(emailCfg.imapPass || ""),
        IMAP_HOST: String(emailCfg.imapHost || "imap.gmail.com"),
        IMAP_PORT: String(emailCfg.imapPort || 993),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Serialize in-process imports (sql.js / connection writes)
    let importChain = Promise.resolve();

    const handleLine = (line) => {
      const text = String(line || "").replace(/\r$/, "");
      if (!text.trim()) return;

      // Don't spam UI with raw token JSON marker lines
      if (text.includes(IMPORT_MARKER)) {
        const parsed = parseFarmLogLine(text);
        if (parsed.type === "import" && parsed.payload) {
          importChain = importChain
            .then(async () => {
              try {
                const conn = await importGrokCliInProcess(parsed.payload);
                const email = conn.email || parsed.payload.email || "grok-cli";
                if (!created.has(email)) {
                  created.add(email);
                  summary.success += 1;
                }
                onLog({
                  level: "success",
                  step: "import",
                  message: `Saved grok-cli connection in-process id=${conn.id} email=${email}`,
                  email,
                });
                onResult({
                  email,
                  provider: "grok-cli",
                  success: true,
                  connectionId: conn.id,
                  message: "Registered + saved to 9router (direct)",
                });
              } catch (e) {
                onLog({
                  level: "error",
                  step: "import",
                  message: `In-process import failed: ${e.message}`,
                });
                summary.errors.push(e.message);
              }
            })
            .catch(() => {});
        }
        return;
      }

      const parsed = parseFarmLogLine(text);

      if (parsed.type === "slog") {
        const p = parsed.progress || {};
        onLog({
          level: parsed.level || "info",
          step: (parsed.phase || "farm").toLowerCase(),
          message: parsed.message || text,
          worker: parsed.worker || null,
          phase: parsed.phase || null,
          email: parsed.email || null,
          progress: {
            worker: parsed.worker || null,
            localCur: p.localCur,
            localShare: p.localShare,
            globalIdx: p.globalIdx,
            globalTotal: p.globalTotal,
            remW: p.remW,
            ok: p.ok,
            fail: p.fail,
          },
        });
        if (
          (parsed.phase === "CREATED" || parsed.phase === "OK" || parsed.phase === "DONE") &&
          parsed.email &&
          !created.has(parsed.email)
        ) {
          created.add(parsed.email);
        }
        return;
      }

      if (parsed.type === "created" && parsed.email && !created.has(parsed.email)) {
        created.add(parsed.email);
        onLog({
          level: "success",
          step: "created",
          message: `Account created: ${parsed.email}`,
          email: parsed.email,
        });
        return;
      }

      // Skip pure noise heartbeats from IMAP wait
      if (/\[IMAP\]\s*waiting\.\.\./i.test(text)) return;

      const level = /\[Error\]|error|failed|Traceback/i.test(text)
        ? "error"
        : /Warn|warning|still on form/i.test(text)
          ? "warn"
          : /CREATED|success|complete|ready|✓/i.test(text)
            ? "success"
            : "info";
      onLog({ level, step: "farm", message: text });
    };

    readline.createInterface({ input: child.stdout }).on("line", handleLine);
    readline.createInterface({ input: child.stderr }).on("line", handleLine);

    child.on("error", (err) => {
      onLog({ level: "error", step: "spawn", message: err.message });
      summary.errors.push(err.message);
      reject(err);
    });

    child.on("close", (code) => {
      importChain.finally(() => {
        if (summary.total > 0) {
          const missing = Math.max(0, summary.total - summary.success);
          if (missing > 0) summary.failed = missing;
        }
        onLog({
          level: code === 0 ? "success" : "warn",
          step: "done",
          message: `Farm exited code ${code}; saved≈${summary.success} (direct DB, no HTTP)`,
        });
        // Always resolve with summary so SSE gets a clean `done` (not failed/error).
        // Zero registrations is a soft result, not a transport failure.
        onDone(summary);
        resolve(summary);
      });
    });
  });

  return summary;
}
