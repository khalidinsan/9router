export class AutomationQueue {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
    this.onResult = options.onResult || (() => {});
    this.onDone = options.onDone || (() => {});
    this.concurrency = options.concurrency || 1;
    this.headless = options.headless !== false;
    this.proxy = options.proxy || null;
    this.saveCredentials = options.saveCredentials || null;
    this.pm = options.playwrightManager || null;
  }

  async run(jobs, providerFactory) {
    if (!this.pm) {
      const { PlaywrightManager } = await import("./PlaywrightManager.js");
      this.pm = new PlaywrightManager({ headless: this.headless, proxy: this.proxy });
    }

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
    if (!this.saveCredentials) {
      const { saveCredentials } = await import("./CredentialSaver.js");
      this.saveCredentials = saveCredentials;
    }

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
      const saved = await this.saveCredentials(provider, { email, ...creds });
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
