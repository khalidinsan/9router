import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { PlaywrightManager } from "../../../open-sse/services/automation/core/PlaywrightManager.js";

describe("PlaywrightManager", () => {
  const makeMocks = () => {
    const newContextMock = mock.fn(async (options) => ({ options }));
    const closeMock = mock.fn(async () => {});
    const launchMock = mock.fn(async () => ({
      newContext: newContextMock,
      close: closeMock,
    }));
    const launchOptionsMock = mock.fn(async () => ({ args: ["--camoufox"] }));

    return {
      launchOptionsMock,
      browserLauncher: { launch: launchMock },
      newContextMock,
      closeMock,
    };
  };

  it("stores options with sensible defaults", () => {
    const manager = new PlaywrightManager();

    assert.equal(manager.headless, true);
    assert.equal(manager.proxy, null);
    assert.equal(manager.browser, null);
  });

  it("stores explicit options", () => {
    const manager = new PlaywrightManager({
      headless: false,
      proxy: "http://proxy.example.com:8080",
    });

    assert.equal(manager.headless, false);
    assert.equal(manager.proxy, "http://proxy.example.com:8080");
  });

  it("launches a browser with camoufox options", async () => {
    const { launchOptionsMock, browserLauncher } = makeMocks();
    const manager = new PlaywrightManager({
      headless: false,
      launchOptionsFn: launchOptionsMock,
      browserLauncher,
    });

    const browser = await manager.getBrowser();

    assert.equal(launchOptionsMock.mock.callCount(), 1);
    assert.deepEqual(launchOptionsMock.mock.calls[0].arguments, [{ headless: false }]);
    assert.equal(browserLauncher.launch.mock.callCount(), 1);
    assert.deepEqual(browserLauncher.launch.mock.calls[0].arguments[0], {
      args: ["--camoufox"],
      headless: false,
    });
    assert.equal(browser, await manager.getBrowser());
  });

  it("passes proxy to launch args when configured", async () => {
    const { launchOptionsMock, browserLauncher } = makeMocks();
    const manager = new PlaywrightManager({
      headless: true,
      proxy: "http://proxy.example.com:8080",
      launchOptionsFn: launchOptionsMock,
      browserLauncher,
    });

    await manager.getBrowser();

    assert.deepEqual(browserLauncher.launch.mock.calls[0].arguments[0], {
      args: ["--camoufox"],
      headless: true,
      proxy: { server: "http://proxy.example.com:8080" },
    });
  });

  it("reuses the same browser instance across calls", async () => {
    const { browserLauncher } = makeMocks();
    const manager = new PlaywrightManager({
      browserLauncher,
      launchOptionsFn: async () => ({}),
    });

    const browserA = await manager.getBrowser();
    const browserB = await manager.getBrowser();

    assert.equal(browserA, browserB);
    assert.equal(browserLauncher.launch.mock.callCount(), 1);
  });

  it("creates a new context with default viewport", async () => {
    const { browserLauncher, newContextMock } = makeMocks();
    const manager = new PlaywrightManager({
      browserLauncher,
      launchOptionsFn: async () => ({}),
    });

    const context = await manager.newContext();

    assert.equal(newContextMock.mock.callCount(), 1);
    assert.deepEqual(newContextMock.mock.calls[0].arguments[0], {
      viewport: { width: 1280, height: 800 },
    });
    assert.deepEqual(context, {
      options: { viewport: { width: 1280, height: 800 } },
    });
  });

  it("merges custom context options", async () => {
    const { browserLauncher, newContextMock } = makeMocks();
    const manager = new PlaywrightManager({
      browserLauncher,
      launchOptionsFn: async () => ({}),
    });

    await manager.newContext({
      locale: "en-US",
      viewport: { width: 1920, height: 1080 },
    });

    assert.deepEqual(newContextMock.mock.calls[0].arguments[0], {
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
    });
  });

  it("propagates proxy to context when not overridden", async () => {
    const { browserLauncher, newContextMock } = makeMocks();
    const manager = new PlaywrightManager({
      proxy: "http://proxy.example.com:8080",
      browserLauncher,
      launchOptionsFn: async () => ({}),
    });

    await manager.newContext();

    assert.deepEqual(newContextMock.mock.calls[0].arguments[0], {
      viewport: { width: 1280, height: 800 },
      proxy: { server: "http://proxy.example.com:8080" },
    });
  });

  it("does not override explicit context proxy", async () => {
    const { browserLauncher, newContextMock } = makeMocks();
    const manager = new PlaywrightManager({
      proxy: "http://proxy.example.com:8080",
      browserLauncher,
      launchOptionsFn: async () => ({}),
    });

    await manager.newContext({
      proxy: { server: "http://other-proxy.example.com:8080" },
    });

    assert.deepEqual(newContextMock.mock.calls[0].arguments[0], {
      viewport: { width: 1280, height: 800 },
      proxy: { server: "http://other-proxy.example.com:8080" },
    });
  });

  it("closes the browser and resets state", async () => {
    const { browserLauncher, closeMock } = makeMocks();
    const manager = new PlaywrightManager({
      browserLauncher,
      launchOptionsFn: async () => ({}),
    });

    await manager.getBrowser();
    await manager.close();

    assert.equal(closeMock.mock.callCount(), 1);
    assert.equal(manager.browser, null);
  });

  it("close is a no-op when no browser is open", async () => {
    const { browserLauncher, closeMock } = makeMocks();
    const manager = new PlaywrightManager({
      browserLauncher,
      launchOptionsFn: async () => ({}),
    });

    await assert.doesNotReject(() => manager.close());
    assert.equal(closeMock.mock.callCount(), 0);
  });
});
