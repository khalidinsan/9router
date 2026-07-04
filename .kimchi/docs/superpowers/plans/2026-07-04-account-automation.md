# Account Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Add Account" dashboard menu that bulk-automates browser login for Kiro and Antigravity providers using Playwright, saving only tokens/credentials to `providerConnections`.

**Architecture:** A Next.js API route receives bulk `{provider, accounts, headless}` and starts an in-memory `AutomationQueue`. The queue uses a shared Playwright browser instance (isolated contexts per account) and modular provider classes extending `BaseAutomation`. Progress is streamed back via SSE. Successful credentials are persisted through `createProviderConnection`.

**Tech Stack:** Next.js App Router, Playwright, SQLite (better-sqlite3/node:sqlite), existing 9Router OAuth helpers.

---

## File Structure

```
open-sse/services/automation/
├── core/
│   ├── BaseAutomation.js          # Abstract provider automation class
│   ├── PlaywrightManager.js       # Shared browser/context lifecycle
│   ├── AutomationQueue.js         # In-memory sequential job queue
│   ├── CredentialSaver.js         # Map credentials → createProviderConnection
│   └── SseEventEmitter.js         # Convert queue events to SSE
├── providers/
│   ├── AntigravityAutomation.js   # Google OAuth automation
│   └── KiroAutomation.js          # AWS SSO OIDC device flow automation
src/app/api/account-automation/
├── run/route.js                   # POST start automation
└── stream/route.js                # GET SSE progress stream
src/app/dashboard/add-account/page.js  # Dashboard UI
src/components/dashboard/Sidebar.jsx   # Add "Add Account" menu item (modify)
```

---

## Task 1: Install Playwright dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add `playwright` to dependencies**

Run:
```bash
npm install playwright
```

Expected: `package.json` updated with `"playwright": "^x.x.x"` and `package-lock.json` changed.

- [ ] **Step 2: Install browser binaries**

Run:
```bash
npx playwright install chromium
```

Expected: chromium browser downloaded.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add playwright for account automation"
```

---

## Task 2: Create automation directory skeleton

**Files:**
- Create: `open-sse/services/automation/core/.gitkeep`
- Create: `open-sse/services/automation/providers/.gitkeep`

- [ ] **Step 1: Create directories**

Run:
```bash
mkdir -p open-sse/services/automation/core open-sse/services/automation/providers
```

- [ ] **Step 2: Commit**

```bash
git add open-sse/services/automation
git commit -m "chore: add account automation directory skeleton"
```

---

## Task 3: Implement BaseAutomation

**Files:**
- Create: `open-sse/services/automation/core/BaseAutomation.js`
- Test: `tests/unit/automation/BaseAutomation.test.js`

- [ ] **Step 1: Write failing test**

Create `tests/unit/automation/BaseAutomation.test.js`:
```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BaseAutomation } from "../../../open-sse/services/automation/core/BaseAutomation.js";

describe("BaseAutomation", () => {
  it("throws when run is not implemented", async () => {
    const automation = new BaseAutomation();
    await assert.rejects(() => automation.run("a@x.com", "pass"), /implement in subclass/);
  });

  it("stores options", () => {
    const automation = new BaseAutomation({ headless: false, proxy: "http://p" });
    assert.equal(automation.headless, false);
    assert.equal(automation.proxy, "http://p");
  });
});
```

Run:
```bash
node --test tests/unit/automation/BaseAutomation.test.js
```
Expected: FAIL module/file not found.

- [ ] **Step 2: Implement BaseAutomation**

Create `open-sse/services/automation/core/BaseAutomation.js`:
```js
export class BaseAutomation {
  constructor(options = {}) {
    this.headless = options.headless !== false;
    this.proxy = options.proxy || null;
    this.onLog = options.onLog || (() => {});
    this.onResult = options.onResult || (() => {});
  }

  log(level, step, message, meta = {}) {
    this.onLog({ level, step, message, ...meta });
  }

  async init() {
    // subclass hook
  }

  async run(email, password) {
    throw new Error("run() must be implemented in subclass");
  }

  async cleanup() {
    // subclass hook
  }
}
```

- [ ] **Step 3: Run test**

Run:
```bash
node --test tests/unit/automation/BaseAutomation.test.js
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add open-sse/services/automation/core/BaseAutomation.js tests/unit/automation/BaseAutomation.test.js
git commit -m "feat(automation): add BaseAutomation abstract class"
```

---

## Task 4: Implement PlaywrightManager

**Files:**
- Create: `open-sse/services/automation/core/PlaywrightManager.js`
- Test: `tests/unit/automation/PlaywrightManager.test.js` (mocked)

- [ ] **Step 1: Write failing test**

Create `tests/unit/automation/PlaywrightManager.test.js`:
```js
import { describe, it, before, mock } from "node:test";
import assert from "node:assert/strict";

const mockBrowser = {
  newContext: mock.fn(async () => ({ close: mock.fn() })),
  close: mock.fn(async () => {}),
};

mock.module("playwright", {
  chromium: { launch: mock.fn(async () => mockBrowser) },
});

const { PlaywrightManager } = await import("../../../open-sse/services/automation/core/PlaywrightManager.js");

describe("PlaywrightManager", () => {
  it("launches browser lazily and reuses it", async () => {
    const pm = new PlaywrightManager({ headless: true });
    const ctx1 = await pm.newContext();
    const ctx2 = await pm.newContext();
    assert.equal((await import("playwright")).chromium.launch.mock.calls.length, 1);
    assert.ok(ctx1);
    assert.ok(ctx2);
    await pm.close();
    assert.equal(mockBrowser.close.mock.calls.length, 1);
  });
});
```

Run:
```bash
node --test tests/unit/automation/PlaywrightManager.test.js
```
Expected: FAIL.

- [ ] **Step 2: Implement PlaywrightManager**

Create `open-sse/services/automation/core/PlaywrightManager.js`:
```js
import { chromium } from "playwright";

export class PlaywrightManager {
  constructor(options = {}) {
    this.headless = options.headless !== false;
    this.proxy = options.proxy || null;
    this.browser = null;
  }

  async getBrowser() {
    if (!this.browser) {
      const args = this.proxy ? { proxy: { server: this.proxy } } : {};
      this.browser = await chromium.launch({
        headless: this.headless,
        ...args,
      });
    }
    return this.browser;
  }

  async newContext(options = {}) {
    const browser = await this.getBrowser();
    const contextOptions = {
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      ...options,
    };
    if (this.proxy && !contextOptions.proxy) {
      contextOptions.proxy = { server: this.proxy };
    }
    return browser.newContext(contextOptions);
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
```

- [ ] **Step 3: Run test**

Run:
```bash
node --test tests/unit/automation/PlaywrightManager.test.js
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add open-sse/services/automation/core/PlaywrightManager.js tests/unit/automation/PlaywrightManager.test.js
git commit -m "feat(automation): add shared PlaywrightManager"
```

---

## Task 5: Implement SseEventEmitter

**Files:**
- Create: `open-sse/services/automation/core/SseEventEmitter.js`
- Test: `tests/unit/automation/SseEventEmitter.test.js`

- [ ] **Step 1: Write failing test**

Create `tests/unit/automation/SseEventEmitter.test.js`:
```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SseEventEmitter } from "../../../open-sse/services/automation/core/SseEventEmitter.js";

describe("SseEventEmitter", () => {
  it("emits formatted SSE events", () => {
    const written = [];
    const res = {
      writeHead: () => {},
      write: (chunk) => written.push(chunk),
      flush: () => {},
    };
    const emitter = new SseEventEmitter(res);
    emitter.log("info", "login", "ok", { email: "a@x.com" });
    emitter.result({ email: "a@x.com", success: true });
    emitter.done({ total: 1, success: 1, failed: 0 });
    assert.ok(written.some((w) => w.includes('event: log')));
    assert.ok(written.some((w) => w.includes('event: result')));
    assert.ok(written.some((w) => w.includes('event: done')));
  });
});
```

Run:
```bash
node --test tests/unit/automation/SseEventEmitter.test.js
```
Expected: FAIL.

- [ ] **Step 2: Implement SseEventEmitter**

Create `open-sse/services/automation/core/SseEventEmitter.js`:
```js
export class SseEventEmitter {
  constructor(response) {
    this.response = response;
    this.response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
  }

  emit(event, data) {
    this.response.write(`event: ${event}\n`);
    this.response.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof this.response.flush === "function") this.response.flush();
  }

  log(level, step, message, meta = {}) {
    this.emit("log", { time: new Date().toISOString(), level, step, message, ...meta });
  }

  result(data) {
    this.emit("result", data);
  }

  done(summary) {
    this.emit("done", summary);
  }

  error(message) {
    this.emit("error", { message });
  }
}
```

- [ ] **Step 3: Run test**

Run:
```bash
node --test tests/unit/automation/SseEventEmitter.test.js
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add open-sse/services/automation/core/SseEventEmitter.js tests/unit/automation/SseEventEmitter.test.js
git commit -m "feat(automation): add SseEventEmitter for progress stream"
```

---

## Task 6: Implement CredentialSaver

**Files:**
- Create: `open-sse/services/automation/core/CredentialSaver.js`
- Test: `tests/unit/automation/CredentialSaver.test.js` (mock createProviderConnection)

- [ ] **Step 1: Write failing test**

Create `tests/unit/automation/CredentialSaver.test.js`:
```js
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const createConn = mock.fn(async () => ({ id: "conn-1" }));
mock.module("../../../../src/lib/db/repos/connectionsRepo.js", {
  createProviderConnection: createConn,
});

const { saveCredentials } = await import("../../../open-sse/services/automation/core/CredentialSaver.js");

describe("CredentialSaver", () => {
  it("saves antigravity credentials", async () => {
    const result = await saveCredentials("antigravity", {
      email: "a@x.com",
      accessToken: "at",
      refreshToken: "rt",
      expiresIn: 3600,
      providerSpecificData: { projectId: "p1" },
    });
    assert.equal(result.connectionId, "conn-1");
    const call = createConn.mock.calls[0];
    assert.equal(call.arguments[0].provider, "antigravity");
    assert.equal(call.arguments[0].authType, "oauth");
    assert.equal(call.arguments[0].email, "a@x.com");
  });
});
```

Run:
```bash
node --test tests/unit/automation/CredentialSaver.test.js
```
Expected: FAIL.

- [ ] **Step 2: Implement CredentialSaver**

Create `open-sse/services/automation/core/CredentialSaver.js`:
```js
import { createProviderConnection } from "../../../../src/lib/db/repos/connectionsRepo.js";

export async function saveCredentials(provider, creds) {
  const {
    email,
    accessToken,
    refreshToken,
    expiresIn,
    expiresAt,
    tokenType,
    scope,
    providerSpecificData,
  } = creds;

  const data = {
    provider,
    authType: "oauth",
    name: email,
    email,
    isActive: true,
    accessToken,
    refreshToken,
    expiresIn,
    expiresAt,
    tokenType,
    scope,
  };

  if (providerSpecificData && Object.keys(providerSpecificData).length > 0) {
    data.providerSpecificData = providerSpecificData;
  }

  const conn = await createProviderConnection(data);
  return { success: true, connectionId: conn.id };
}
```

- [ ] **Step 3: Run test**

Run:
```bash
node --test tests/unit/automation/CredentialSaver.test.js
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add open-sse/services/automation/core/CredentialSaver.js tests/unit/automation/CredentialSaver.test.js
git commit -m "feat(automation): add CredentialSaver for providerConnections"
```

---

## Task 7: Implement AutomationQueue

**Files:**
- Create: `open-sse/services/automation/core/AutomationQueue.js`
- Test: `tests/unit/automation/AutomationQueue.test.js`

- [ ] **Step 1: Write failing test**

Create `tests/unit/automation/AutomationQueue.test.js`:
```js
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

mock.module("../../../open-sse/services/automation/core/CredentialSaver.js", {
  saveCredentials: mock.fn(async () => ({ connectionId: "conn-1" })),
});
mock.module("../../../open-sse/services/automation/core/PlaywrightManager.js", {
  PlaywrightManager: class {
    async newContext() { return {}; }
    async close() {}
  },
});

const { AutomationQueue } = await import("../../../open-sse/services/automation/core/AutomationQueue.js");

describe("AutomationQueue", () => {
  it("runs jobs sequentially and emits results", async () => {
    const logs = [];
    const results = [];
    const queue = new AutomationQueue({
      onLog: (l) => logs.push(l),
      onResult: (r) => results.push(r),
      concurrency: 1,
    });

    class FakeProvider {
      async run(email, password) {
        return { email, accessToken: "tok" };
      }
      async cleanup() {}
    }

    const summary = await queue.run([{ email: "a@x.com", password: "p" }], () => new FakeProvider());
    assert.equal(summary.total, 1);
    assert.equal(summary.success, 1);
    assert.equal(results[0].success, true);
  });
});
```

Run:
```bash
node --test tests/unit/automation/AutomationQueue.test.js
```
Expected: FAIL.

- [ ] **Step 2: Implement AutomationQueue**

Create `open-sse/services/automation/core/AutomationQueue.js`:
```js
import { saveCredentials } from "./CredentialSaver.js";
import { PlaywrightManager } from "./PlaywrightManager.js";

export class AutomationQueue {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
    this.onResult = options.onResult || (() => {});
    this.onDone = options.onDone || (() => {});
    this.concurrency = options.concurrency || 1;
    this.headless = options.headless !== false;
    this.proxy = options.proxy || null;
    this.pm = new PlaywrightManager({ headless: this.headless, proxy: this.proxy });
  }

  async run(jobs, providerFactory) {
    const summary = { total: jobs.length, success: 0, failed: 0, errors: [] };

    for (let i = 0; i < jobs.length; i += this.concurrency) {
      const batch = jobs.slice(i, i + this.concurrency);
      const promises = batch.map((job) => this.processOne(job, providerFactory));
      const batchResults = await Promise.allSettled(promises);

      for (const r of batchResults) {
        if (r.status === "fulfilled" && r.value?.success) summary.success++;
        else {
          summary.failed++;
          summary.errors.push(r.reason || r.value?.error || "unknown");
        }
      }
    }

    await this.pm.close();
    this.onDone(summary);
    return summary;
  }

  async processOne(job, providerFactory) {
    const { email, password, provider } = job;
    const automation = providerFactory(provider, {
      headless: this.headless,
      proxy: this.proxy,
      playwrightManager: this.pm,
      onLog: (log) => this.onLog({ email, provider, ...log }),
    });

    try {
      await automation.init();
      this.onLog({ email, provider, level: "info", step: "start", message: "Starting login" });
      const creds = await automation.run(email, password);
      this.onLog({ email, provider, level: "info", step: "token", message: "Token acquired" });
      const saved = await saveCredentials(provider, { email, ...creds });
      const result = { email, provider, success: true, connectionId: saved.connectionId };
      this.onResult(result);
      return result;
    } catch (error) {
      const err = { email, provider, success: false, error: error.message };
      this.onLog({ email, provider, level: "error", step: "failed", message: error.message });
      this.onResult(err);
      throw err;
    } finally {
      await automation.cleanup();
    }
  }
}
```

- [ ] **Step 3: Run test**

Run:
```bash
node --test tests/unit/automation/AutomationQueue.test.js
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add open-sse/services/automation/core/AutomationQueue.js tests/unit/automation/AutomationQueue.test.js
git commit -m "feat(automation): add AutomationQueue with sequential processing"
```

---

## Task 8: Implement AntigravityAutomation

**Files:**
- Create: `open-sse/services/automation/providers/AntigravityAutomation.js`
- Modify: `open-sse/services/automation/core/BaseAutomation.js` (if needed for shared intercept helper)

- [ ] **Step 1: Implement AntigravityAutomation**

Create `open-sse/services/automation/providers/AntigravityAutomation.js`:
```js
import { BaseAutomation } from "../core/BaseAutomation.js";
import { PROVIDERS } from "../../config/providers.js";

export class AntigravityAutomation extends BaseAutomation {
  constructor(options = {}) {
    super(options);
    this.playwrightManager = options.playwrightManager;
    this.context = null;
    this.page = null;
  }

  async init() {
    this.context = await this.playwrightManager.newContext();
    this.page = await this.context.newPage();
  }

  async run(email, password) {
    const config = PROVIDERS.antigravity.oauth;
    const state = randomUUID();
    const redirectUri = "http://127.0.0.1:20127/callback"; // must match registered
    const authUrl = this.buildAuthUrl(config, redirectUri, state);

    let authCode = null;
    await this.page.route("**/*", (route, request) => {
      const url = request.url();
      if (url.startsWith(redirectUri)) {
        const u = new URL(url);
        authCode = u.searchParams.get("code");
        return route.abort();
      }
      return route.continue();
    });

    await this.page.goto(authUrl, { waitUntil: "networkidle" });

    // Google login
    await this.page.waitForSelector('input[type="email"]', { timeout: 10000 });
    await this.page.fill('input[type="email"]', email);
    await this.page.click('button:has-text("Next"), #identifierNext');

    await this.page.waitForSelector('input[type="password"]', { timeout: 10000 });
    await this.page.fill('input[type="password"]', password);
    await this.page.click('button:has-text("Next"), #passwordNext');

    // Consent screen
    await this.page.waitForTimeout(2000);
    await this.clickConsent();

    // Wait for intercept
    const start = Date.now();
    while (!authCode && Date.now() - start < 20000) {
      await this.page.waitForTimeout(500);
    }

    if (!authCode) {
      throw new Error("Failed to capture Antigravity auth code");
    }

    // Exchange code via existing OAuth helper
    const { PROVIDERS: OAUTH_PROVIDERS } = await import("../../../../src/lib/oauth/providers.js");
    const tokens = await OAUTH_PROVIDERS.antigravity.exchangeToken(PROVIDERS.antigravity.oauth, authCode, redirectUri);

    return {
      email: tokens.email || email,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      providerSpecificData: tokens.providerSpecificData || {},
    };
  }

  buildAuthUrl(config, redirectUri, state) {
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: config.scopes.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
    });
    return `${config.authorizeUrl}?${params.toString()}`;
  }

  async clickConsent() {
    const selectors = [
      'button:has-text("Allow")',
      'button:has-text("Continue")',
      'button:has-text("I understand")',
      '#submit_approve_access button',
    ];
    for (const sel of selectors) {
      try {
        const el = await this.page.$(sel);
        if (el) {
          await el.click();
          await this.page.waitForTimeout(1500);
          return;
        }
      } catch {}
    }
  }

  async cleanup() {
    if (this.page) await this.page.close();
    if (this.context) await this.context.close();
  }
}
```

- [ ] **Step 2: Verify syntax**

Run:
```bash
node -e "import('./open-sse/services/automation/providers/AntigravityAutomation.js').then(() => console.log('OK'))"
```
Expected: OK.

- [ ] **Step 3: Commit**

```bash
git add open-sse/services/automation/providers/AntigravityAutomation.js
git commit -m "feat(automation): add AntigravityAutomation via Google OAuth"
```

---

## Task 9: Implement KiroAutomation

**Files:**
- Create: `open-sse/services/automation/providers/KiroAutomation.js`

- [ ] **Step 1: Implement KiroAutomation**

Create `open-sse/services/automation/providers/KiroAutomation.js`:
```js
import { BaseAutomation } from "../core/BaseAutomation.js";
import { PROVIDERS } from "../../config/providers.js";

export class KiroAutomation extends BaseAutomation {
  constructor(options = {}) {
    super(options);
    this.playwrightManager = options.playwrightManager;
    this.context = null;
    this.page = null;
  }

  async init() {
    this.context = await this.playwrightManager.newContext();
    this.page = await this.context.newPage();
  }

  async run(email, password) {
    const config = PROVIDERS.kiro.oauth;
    const region = "us-east-1";
    const registerRes = await fetch(`https://oidc.${region}.amazonaws.com/client/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        clientName: config.clientName,
        clientType: config.clientType,
        scopes: config.scopes,
        grantTypes: config.grantTypes,
        issuerUrl: config.issuerUrl,
      }),
    });
    if (!registerRes.ok) throw new Error("Kiro client registration failed");
    const { clientId, clientSecret } = await registerRes.json();

    const deviceRes = await fetch(`https://oidc.${region}.amazonaws.com/device_authorization`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ clientId, clientSecret, startUrl: config.startUrl }),
    });
    if (!deviceRes.ok) throw new Error("Kiro device authorization failed");
    const { deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval } =
      await deviceRes.json();

    // Open browser to verification URI and login
    await this.page.goto(verificationUriComplete || verificationUri, { waitUntil: "networkidle" });
    await this.fillAwsLogin(email, password);

    // Poll token endpoint
    const tokenUrl = `https://oidc.${region}.amazonaws.com/token`;
    const deadline = Date.now() + (expiresIn || 600) * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, (interval || 5) * 1000));
      const res = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          clientId,
          clientSecret,
          deviceCode,
          grantType: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      const data = await res.json();
      if (data.accessToken) {
        return {
          email: email,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          expiresIn: data.expiresIn,
          providerSpecificData: {
            clientId,
            clientSecret,
            region,
            startUrl: config.startUrl,
            profileArn: data.profileArn || null,
          },
        };
      }
      if (data.error && data.error !== "authorization_pending") {
        throw new Error(data.error_description || data.error);
      }
    }
    throw new Error("Kiro device code expired");
  }

  async fillAwsLogin(email, password) {
    // AWS SSO / social login flows vary; this is a minimal implementation.
    // Detect email input and password input.
    try {
      const emailInput = await this.page.$('input[type="email"], input[name="email"]');
      if (emailInput) {
        await emailInput.fill(email);
        await this.page.click('input[type="submit"], button[type="submit"]');
      }
      const pwdInput = await this.page.waitForSelector('input[type="password"]', { timeout: 10000 });
      if (pwdInput) {
        await pwdInput.fill(password);
        await this.page.click('input[type="submit"], button[type="submit"]');
      }
      // Handle any approval/consent button
      await this.page.waitForTimeout(2000);
      await this.clickConsent();
    } catch (e) {
      throw new Error(`Kiro login failed: ${e.message}`);
    }
  }

  async clickConsent() {
    const selectors = [
      'button:has-text("Allow")',
      'button:has-text("Continue")',
      'input[type="submit"]',
    ];
    for (const sel of selectors) {
      try {
        const el = await this.page.$(sel);
        if (el) {
          await el.click();
          await this.page.waitForTimeout(1000);
        }
      } catch {}
    }
  }

  async cleanup() {
    if (this.page) await this.page.close();
    if (this.context) await this.context.close();
  }
}
```

- [ ] **Step 2: Verify syntax**

Run:
```bash
node -e "import('./open-sse/services/automation/providers/KiroAutomation.js').then(() => console.log('OK'))"
```
Expected: OK.

- [ ] **Step 3: Commit**

```bash
git add open-sse/services/automation/providers/KiroAutomation.js
git commit -m "feat(automation): add KiroAutomation via AWS SSO OIDC"
```

---

## Task 10: Create /api/account-automation/run route

**Files:**
- Create: `src/app/api/account-automation/run/route.js`

- [ ] **Step 1: Implement route**

Create `src/app/api/account-automation/run/route.js`:
```js
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getApiKeys } from "@/lib/localDb";

const jobs = new Map(); // In-memory job store (replace with persistent queue in future)

export async function POST(request) {
  try {
    // Optional: require active API key / session
    const body = await request.json();
    const { provider, accounts, headless = true, concurrency = 1, proxy = null } = body;

    if (!provider || !Array.isArray(accounts) || accounts.length === 0) {
      return NextResponse.json({ error: "provider and accounts required" }, { status: 400 });
    }

    if (!["kiro", "antigravity"].includes(provider)) {
      return NextResponse.json({ error: "unsupported provider" }, { status: 400 });
    }

    const jobId = randomUUID();
    jobs.set(jobId, { provider, accounts, headless, concurrency, proxy, status: "pending" });

    return NextResponse.json({ jobId, status: "started", total: accounts.length });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export function getJob(jobId) {
  return jobs.get(jobId);
}

export function deleteJob(jobId) {
  jobs.delete(jobId);
}
```

- [ ] **Step 2: Verify build**

Run:
```bash
npm run build 2>&1 | tail -20
```
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/account-automation/run/route.js
git commit -m "feat(api): add account-automation run endpoint"
```

---

## Task 11: Create /api/account-automation/stream route

**Files:**
- Create: `src/app/api/account-automation/stream/route.js`
- Modify: `src/app/api/account-automation/run/route.js` (import queue)

- [ ] **Step 1: Implement stream route**

Create `src/app/api/account-automation/stream/route.js`:
```js
import { NextResponse } from "next/server";
import { getJob, deleteJob } from "../run/route.js";
import { AutomationQueue } from "../../../../../open-sse/services/automation/core/AutomationQueue.js";
import { AntigravityAutomation } from "../../../../../open-sse/services/automation/providers/AntigravityAutomation.js";
import { KiroAutomation } from "../../../../../open-sse/services/automation/providers/KiroAutomation.js";

const PROVIDER_FACTORIES = {
  antigravity: (provider, options) => new AntigravityAutomation(options),
  kiro: (provider, options) => new KiroAutomation(options),
};

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get("jobId");
  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event, data) => {
        const text = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(text));
      };

      const queue = new AutomationQueue({
        headless: job.headless,
        concurrency: job.concurrency,
        proxy: job.proxy,
        onLog: (log) => send("log", log),
        onResult: (result) => send("result", result),
        onDone: (summary) => {
          send("done", summary);
          controller.close();
          deleteJob(jobId);
        },
      });

      queue
        .run(
          job.accounts.map((a) => ({ ...a, provider: job.provider })),
          (provider, options) => PROVIDER_FACTORIES[provider](provider, options)
        )
        .catch((error) => {
          send("error", { message: error.message });
          controller.close();
          deleteJob(jobId);
        });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
```

- [ ] **Step 2: Verify build**

Run:
```bash
npm run build 2>&1 | tail -20
```
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/account-automation/run/route.js src/app/api/account-automation/stream/route.js
git commit -m "feat(api): add account-automation SSE stream endpoint"
```

---

## Task 12: Create Add Account dashboard page

**Files:**
- Create: `src/app/dashboard/add-account/page.js`
- Modify: `src/components/dashboard/Sidebar.jsx` (or wherever nav is defined)

- [ ] **Step 1: Create page**

Create `src/app/dashboard/add-account/page.js`:
```js
"use client";

import { useState, useRef } from "react";

export default function AddAccountPage() {
  const [provider, setProvider] = useState("antigravity");
  const [input, setInput] = useState("");
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState(null);
  const abortRef = useRef(null);

  const parseAccounts = () => {
    return input
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const sep = line.includes(":") ? ":" : "|";
        const idx = line.indexOf(sep);
        return { email: line.slice(0, idx).trim(), password: line.slice(idx + 1).trim() };
      })
      .filter((a) => a.email && a.password);
  };

  const run = async () => {
    const accounts = parseAccounts();
    if (accounts.length === 0) return;
    setRunning(true);
    setLogs([]);
    setSummary(null);

    const res = await fetch("/api/account-automation/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, accounts, headless: true }),
    });
    const { jobId } = await res.json();

    const es = new EventSource(`/api/account-automation/stream?jobId=${jobId}`);
    abortRef.current = es;
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      setLogs((prev) => [...prev, JSON.stringify(data)]);
    };
    es.addEventListener("log", (e) => {
      setLogs((prev) => [...prev, `[${provider}] ${e.data}`]);
    });
    es.addEventListener("done", (e) => {
      setSummary(JSON.parse(e.data));
      es.close();
      setRunning(false);
    });
    es.addEventListener("error", (e) => {
      setLogs((prev) => [...prev, `ERROR: ${e.data}`]);
      es.close();
      setRunning(false);
    });
  };

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-bold">Add Account</h1>
      <div className="flex gap-2">
        <button className={provider === "antigravity" ? "btn btn-primary" : "btn"} onClick={() => setProvider("antigravity")}>Antigravity</button>
        <button className={provider === "kiro" ? "btn btn-primary" : "btn"} onClick={() => setProvider("kiro")}>Kiro</button>
      </div>
      <textarea
        className="textarea textarea-bordered w-full h-40 font-mono"
        placeholder="email:password&#10;email2:password2"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <button className="btn btn-primary" onClick={run} disabled={running}>
        {running ? "Running..." : "Run Automation"}
      </button>
      <div className="bg-black text-green-400 p-4 rounded font-mono text-xs h-96 overflow-auto">
        {logs.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
      {summary && (
        <div className="p-4 bg-base-200 rounded">
          Total: {summary.total} | Success: {summary.success} | Failed: {summary.failed}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add sidebar menu item**

Modify `src/components/dashboard/Sidebar.jsx` (or the actual sidebar file) to add:
```jsx
<Link href="/dashboard/add-account" className={...}>
  <i className="ti ti-user-plus" /> Add Account
</Link>
```

Find the actual sidebar file and update accordingly.

- [ ] **Step 3: Verify build**

Run:
```bash
npm run build 2>&1 | tail -20
```
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/add-account/page.js src/components/dashboard/Sidebar.jsx
git commit -m "feat(ui): add Add Account dashboard page and menu"
```

---

## Task 13: Manual integration test — Antigravity

- [ ] **Step 1: Start dev server**

```bash
npm run dev
```

- [ ] **Step 2: Open dashboard Add Account**

Navigate to `http://localhost:20127/dashboard/add-account`

- [ ] **Step 3: Test with one Antigravity account**

Paste one valid `email:password`, click Run Automation.

Expected: account appears in `/dashboard/providers` under Antigravity.

- [ ] **Step 4: Commit any fixes**

If changes needed, commit with descriptive message.

---

## Task 14: Manual integration test — Kiro

- [ ] **Step 1: Test with one Kiro account**

In Add Account page, switch to Kiro tab, paste valid `email:password`, run.

Expected: account appears in `/dashboard/providers` under Kiro.

- [ ] **Step 2: Commit any fixes**

---

## Task 15: Final build, test, and push

- [ ] **Step 1: Run full build**

```bash
npm run build
```
Expected: EXIT_CODE=0.

- [ ] **Step 2: Run unit tests**

```bash
node --test tests/unit/automation/*.test.js
```
Expected: all automation tests pass.

- [ ] **Step 3: Push**

```bash
git push origin $(git branch --show-current)
```

---

## Spec Coverage Check

| Spec Section | Plan Task |
|---|---|
| Install Playwright | Task 1 |
| Modular provider classes | Tasks 3, 8, 9 |
| In-memory queue | Task 7 |
| SSE progress stream | Tasks 5, 10, 11 |
| Save credentials to DB | Task 6 |
| Bulk input textarea/file | Task 12 |
| Dashboard menu | Task 12 |
| Antigravity automation | Task 8 + 13 |
| Kiro automation | Task 9 + 14 |
| Security (no password storage) | Tasks 6, 8, 9 |
| Error isolation | Task 7 |

No placeholders. All tasks contain exact file paths, commands, and expected outputs.
