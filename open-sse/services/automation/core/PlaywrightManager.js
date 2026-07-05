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
      const camoufoxArgs = await this.launchOptionsFn({ headless: this.headless });
      const launchArgs = {
        ...camoufoxArgs,
        headless: this.headless,
      };
      if (this.proxy) {
        launchArgs.proxy = { server: this.proxy };
      }
      this.browser = await this.browserLauncher.launch(launchArgs);
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
