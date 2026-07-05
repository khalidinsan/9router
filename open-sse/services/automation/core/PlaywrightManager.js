import { launchOptions as defaultLaunchOptions } from "camoufox-js";
import { firefox as defaultFirefox } from "playwright-core";

export class PlaywrightManager {
  constructor(options = {}) {
    this.headless = options.headless !== false;
    this.proxy = options.proxy || null;
    this.browser = null;
    this.launchOptionsFn = options.launchOptionsFn || defaultLaunchOptions;
    this.browserLauncher = options.browserLauncher || defaultFirefox;
  }

  async getBrowser() {
    if (!this.browser) {
      let launchArgs = {
        headless: this.headless,
      };
      if (this.proxy) {
        launchArgs.proxy = { server: this.proxy };
      }

      try {
        const camoufoxArgs = await this.launchOptionsFn({ headless: this.headless });
        launchArgs = { ...camoufoxArgs, ...launchArgs };
        this.browser = await this.browserLauncher.launch(launchArgs);
      } catch (err) {
        const message = err?.message || "";
        if (message.includes("Version information not found") || message.includes("camoufox")) {
          console.warn("[PlaywrightManager] Camoufox not installed; falling back to stock Firefox.");
          this.browser = await this.browserLauncher.launch({
            headless: this.headless,
            proxy: this.proxy ? { server: this.proxy } : undefined,
          });
        } else {
          throw err;
        }
      }
    }
    return this.browser;
  }

  async newContext(options = {}) {
    const browser = await this.getBrowser();
    // Camoufox's CDP scheme rejects the default Playwright viewport object
    // (it includes isMobile=false which is not in Camoufox's scheme).
    // Pass viewport: null to let Camoufox manage the viewport natively.
    const contextOptions = {
      viewport: null,
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
