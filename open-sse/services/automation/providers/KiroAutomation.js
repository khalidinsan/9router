import { BaseAutomation } from "../core/BaseAutomation.js";
import { PROVIDERS } from "../../../config/providers.js";

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
