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
    const contextOptions = {
      viewport: { width: 1280, height: 800 },
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
