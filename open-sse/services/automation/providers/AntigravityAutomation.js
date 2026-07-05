import { randomUUID } from "node:crypto";
import { BaseAutomation } from "../core/BaseAutomation.js";
import { ANTIGRAVITY_OAUTH_CLIENT } from "../../../providers/shared.js";


// Must match the redirect URI registered in the Google Cloud Console for the
// Antigravity OAuth client. The upstream agy CLI and the Gsuiteto9router bot
// both use http://localhost:20127/callback; 127.0.0.1 causes invalid_client.
const REDIRECT_URI = "http://localhost:20127/callback";

export class AntigravityAutomation extends BaseAutomation {
  constructor(options = {}) {
    super(options);
    this.playwrightManager = options.playwrightManager;
    this.context = null;
    this.page = null;
  }

  async init() {
    if (!this.playwrightManager) {
      throw new Error("playwrightManager is required");
    }
    this.context = await this.playwrightManager.newContext();
    this.page = await this.context.newPage();
  }

  async run(email, password) {
    const state = randomUUID();
    const authUrl = this.buildAuthUrl(REDIRECT_URI, state);

    let authCode = null;
    await this.page.route("**/*", (route, request) => {
      const url = request.url();
      if (url.startsWith(REDIRECT_URI)) {
        const u = new URL(url);
        authCode = u.searchParams.get("code");
        return route.abort();
      }
      return route.continue();
    });

    await this.page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 20000 });

    // Email step: Google's standard identifier input
    await this.page.waitForSelector('#identifierId', { visible: true, timeout: 10000 });
    await this.page.type('#identifierId', email, { delay: 20 });
    await this.page.waitForTimeout(500);
    await this.page.keyboard.press('Enter');

    // Wait for password challenge to load
    await this.page.waitForTimeout(2000);

    // Try several password-field selectors (Google varies by account/region)
    const pwdSelectors = [
      'input[type="password"][name="Passwd"]',
      'input[type="password"]',
      '#password input',
      'input[name="Passwd"]',
    ];

    let pwdField = null;
    for (const sel of pwdSelectors) {
      try {
        pwdField = await this.page.waitForSelector(sel, { visible: true, timeout: 5000 });
        if (pwdField) break;
      } catch {}
    }

    if (!pwdField) {
      throw new Error(`Password field not found for ${email}`);
    }

    await this.page.waitForTimeout(500);
    await pwdField.type(password, { delay: 20 });
    await this.page.waitForTimeout(500);
    await this.page.keyboard.press('Enter');

    await this.page.waitForTimeout(2000);

    // Google may show multiple consecutive consent/trust screens.
    // Poll clickConsent until we capture the auth code.
    const consentStart = Date.now();
    while (!authCode && Date.now() - consentStart < 25000) {
      await this.clickConsent();
      await this.page.waitForTimeout(2000);
    }

    if (!authCode) {
      throw new Error("Failed to capture Antigravity auth code");
    }

    const { exchangeTokens } = await import("../../../../src/lib/oauth/providers.js");
    return await exchangeTokens("antigravity", authCode, REDIRECT_URI);
  }

  buildAuthUrl(redirectUri, state) {
    const params = new URLSearchParams({
      client_id: ANTIGRAVITY_OAUTH_CLIENT.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/cclog",
        "https://www.googleapis.com/auth/experimentsandconfigs",
      ].join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async clickConsent() {
    // The Google Workspace ToS screen requires scrolling before "I understand"
    // becomes clickable. Click the scroll-down affordance first if present.
    try {
      const scrollDown = await this.page.$('[aria-label="Scroll down"], button:has-text("Scroll down")');
      if (scrollDown) {
        const visible = await scrollDown.isVisible().catch(() => false);
        if (visible) {
          await scrollDown.click();
          await this.page.waitForTimeout(800);
          return;
        }
      }
    } catch {}

    const selectors = [
      '#gaplustosNext button',
      '#gaplustosNext',
      'button:has-text("I understand")',
      'button:has-text("Login")',
      'button:has-text("Log in")',
      'button:has-text("Masuk")',
      'button:has-text("Sign in")',
      '#submit_approve_access button',
      '#submit_approve_access',
      'button:has-text("Allow")',
      'button:has-text("Continue")',
      'button:has-text("Izinkan")',
    ];
    for (const sel of selectors) {
      try {
        const el = await this.page.$(sel);
        if (!el) continue;
        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;
        await el.click();
        await this.page.waitForTimeout(1500);
        return;
      } catch {}
    }
  }

  async cleanup() {
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
  }
}

export default AntigravityAutomation;
