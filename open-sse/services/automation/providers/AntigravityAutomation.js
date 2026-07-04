import { randomUUID } from "node:crypto";
import { BaseAutomation } from "../core/BaseAutomation.js";
import { PROVIDER_OAUTH } from "../../../config/providers.js";


const REDIRECT_URI = "http://127.0.0.1:20127/callback";

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
    const config = PROVIDER_OAUTH.antigravity;
    if (!config) {
      throw new Error("Antigravity OAuth config not found");
    }

    const state = randomUUID();
    const authUrl = this.buildAuthUrl(config, REDIRECT_URI, state);

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

    const { getProvider } = await import("../../../../src/lib/oauth/providers.js");
    const oauthProvider = getProvider("antigravity");
    const tokens = await oauthProvider.exchangeToken(config, authCode, REDIRECT_URI);

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
