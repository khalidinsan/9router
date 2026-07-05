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

    await this.page.goto(authUrl, { waitUntil: "networkidle" });

    await this.page.waitForSelector('input[type="email"]', { timeout: 10000 });
    await this.page.fill('input[type="email"]', email);
    await this.page.click('button:has-text("Next"), #identifierNext');

    await this.page.waitForSelector('input[type="password"]', { timeout: 10000 });
    await this.page.fill('input[type="password"]', password);
    await this.page.click('button:has-text("Next"), #passwordNext');

    await this.page.waitForTimeout(2000);
    await this.clickConsent();

    const start = Date.now();
    while (!authCode && Date.now() - start < 20000) {
      await this.page.waitForTimeout(500);
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
