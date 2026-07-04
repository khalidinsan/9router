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
