import { firefox as defaultFirefox } from "playwright-core";

async function defaultLaunchOptions(options) {
  const nodeMajor = Number(process.versions.node?.split(".")[0] || 0);
  if (!process.versions.bun && nodeMajor < 22) {
    throw new Error(`Camoufox requires Node >=22 (current: ${process.versions.node})`);
  }
  const { launchOptions } = await import("camoufox-js");
  return launchOptions(options);
}

export class PlaywrightManager {
  constructor(options = {}) {
    this.headless = options.headless !== false;
    this.proxy = options.proxy || null;
    this.browser = null;
    this.usingCamoufox = false;
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
        this.usingCamoufox = true;
      } catch (err) {
        const message = err?.message || "";
        const camoufoxUnavailable =
          message.includes("Version information not found") ||
          /camoufox|better-sqlite3|NODE_MODULE_VERSION|ERR_DLOPEN_FAILED/i.test(message);
        if (camoufoxUnavailable) {
          console.warn(`[PlaywrightManager] Camoufox unavailable (${message.split("\n")[0]}); falling back to stock Firefox.`);
          this.browser = await this.browserLauncher.launch({
            headless: this.headless,
            proxy: this.proxy ? { server: this.proxy } : undefined,
          });
          this.usingCamoufox = false;
        } else {
          throw err;
        }
      }
    }
    return this.browser;
  }

  async newContext(options = {}) {
    const browser = await this.getBrowser();
    // Camoufox rejects Playwright's default viewport object. Stock Firefox uses
    // a normal desktop viewport when Camoufox is unavailable (for example on
    // Node <22 or when its native WebGL sampler has an ABI mismatch).
    const contextOptions = {
      viewport: this.usingCamoufox ? null : { width: 1280, height: 800 },
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
