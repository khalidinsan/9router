import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BaseAutomation } from "../../../open-sse/services/automation/core/BaseAutomation.js";

describe("BaseAutomation", () => {
  it("stores options with sensible defaults", () => {
    const onLog = () => {};
    const onResult = () => {};
    const automation = new BaseAutomation({
      headless: false,
      proxy: "http://proxy.example.com",
      onLog,
      onResult,
    });

    assert.equal(automation.headless, false);
    assert.equal(automation.proxy, "http://proxy.example.com");
    assert.equal(automation.onLog, onLog);
    assert.equal(automation.onResult, onResult);
  });

  it("defaults headless to true and callbacks to no-ops", () => {
    const automation = new BaseAutomation();

    assert.equal(automation.headless, true);
    assert.equal(automation.proxy, null);
    assert.equal(typeof automation.onLog, "function");
    assert.equal(typeof automation.onResult, "function");
  });

  it("throws when run() is called on the base class", async () => {
    const automation = new BaseAutomation();

    await assert.rejects(
      () => automation.run("user@example.com", "password123"),
      /run\(\) must be implemented in subclass/,
    );
  });

  it("emits log entries through the onLog callback", () => {
    const logs = [];
    const automation = new BaseAutomation({
      onLog: (entry) => logs.push(entry),
    });

    automation.log("info", "setup", "starting");

    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0], {
      level: "info",
      step: "setup",
      message: "starting",
    });
  });

  it("includes extra metadata in log entries", () => {
    const logs = [];
    const automation = new BaseAutomation({
      onLog: (entry) => logs.push(entry),
    });

    automation.log("debug", "step-1", "details", { account: "a@b.com" });

    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0], {
      level: "debug",
      step: "step-1",
      message: "details",
      account: "a@b.com",
    });
  });

  it("init and cleanup are subclass hooks that resolve", async () => {
    const automation = new BaseAutomation();

    await assert.doesNotReject(() => automation.init());
    await assert.doesNotReject(() => automation.cleanup());
  });
});
