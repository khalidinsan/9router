import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AutomationQueue } from "../../../open-sse/services/automation/core/AutomationQueue.js";

describe("AutomationQueue", () => {
  const makeQueue = (overrides = {}) => {
    return new AutomationQueue({
      saveCredentials: async () => ({ connectionId: "conn-1" }),
      playwrightManager: {
        async getBrowser() {
          return {};
        },
        async newContext() {
          return {};
        },
        async close() {},
      },
      ...overrides,
    });
  };

  it("runs jobs sequentially and emits results", async () => {
    const logs = [];
    const results = [];
    const queue = makeQueue({
      onLog: (l) => logs.push(l),
      onResult: (r) => results.push(r),
      concurrency: 1,
    });

    class FakeProvider {
      async init() {}
      async run(email, password) {
        return { email, accessToken: "tok" };
      }
      async cleanup() {}
    }

    const summary = await queue.run([{ email: "a@x.com", password: "p", provider: "antigravity" }], () => new FakeProvider());
    assert.equal(summary.total, 1);
    assert.equal(summary.success, 1);
    assert.equal(results[0].success, true);
    assert.equal(results[0].connectionId, "conn-1");
  });

  it("isolates failures so one job does not stop the queue", async () => {
    const results = [];
    const queue = makeQueue({
      onResult: (r) => results.push(r),
      concurrency: 1,
    });

    class GoodProvider {
      async init() {}
      async run() {
        return { accessToken: "tok" };
      }
      async cleanup() {}
    }

    class BadProvider {
      async init() {}
      async run() {
        throw new Error("login failed");
      }
      async cleanup() {}
    }

    const summary = await queue.run(
      [
        { email: "good@x.com", password: "p", provider: "antigravity" },
        { email: "bad@x.com", password: "p", provider: "badprovider" },
      ],
      (provider) => (provider === "badprovider" ? new BadProvider() : new GoodProvider()),
    );

    assert.equal(summary.total, 2);
    assert.equal(summary.success, 1);
    assert.equal(summary.failed, 1);
    assert.equal(results.length, 2);
    assert.equal(results.filter((r) => r.success).length, 1);
    assert.equal(results.filter((r) => !r.success).length, 1);
  });

  it("emits done summary after all jobs finish", async () => {
    let doneSummary = null;
    const queue = makeQueue({
      onDone: (s) => {
        doneSummary = s;
      },
    });

    class FakeProvider {
      async init() {}
      async run() {
        return { accessToken: "tok" };
      }
      async cleanup() {}
    }

    await queue.run([{ email: "a@x.com", password: "p", provider: "antigravity" }], () => new FakeProvider());
    assert.ok(doneSummary);
    assert.equal(doneSummary.total, 1);
    assert.equal(doneSummary.success, 1);
    assert.equal(doneSummary.failed, 0);
  });

  it("processes jobs sequentially when concurrency is 1", async () => {
    const order = [];
    const queue = makeQueue({ concurrency: 1 });

    class SlowProvider {
      constructor(id) {
        this.id = id;
      }
      async init() {}
      async run() {
        order.push(`start-${this.id}`);
        await new Promise((r) => setTimeout(r, 10));
        order.push(`end-${this.id}`);
        return { accessToken: "tok" };
      }
      async cleanup() {}
    }

    await queue.run(
      [
        { email: "first@x.com", password: "p", provider: "firstprovider" },
        { email: "second@x.com", password: "p", provider: "secondprovider" },
      ],
      (provider) => new SlowProvider(provider),
    );

    assert.deepEqual(order, ["start-firstprovider", "end-firstprovider", "start-secondprovider", "end-secondprovider"]);
  });
});
