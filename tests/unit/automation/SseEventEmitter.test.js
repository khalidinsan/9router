import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SseEventEmitter } from "../../../open-sse/services/automation/core/SseEventEmitter.js";

describe("SseEventEmitter", () => {
  it("writes SSE headers on construction", () => {
    let headStatus = null;
    let headHeaders = null;
    const res = {
      writeHead: (status, headers) => {
        headStatus = status;
        headHeaders = headers;
      },
      write: () => {},
      flush: () => {},
    };

    new SseEventEmitter(res);

    assert.equal(headStatus, 200);
    assert.equal(headHeaders["Content-Type"], "text/event-stream");
    assert.equal(headHeaders["Cache-Control"], "no-cache");
    assert.equal(headHeaders.Connection, "keep-alive");
    assert.equal(headHeaders["Access-Control-Allow-Origin"], "*");
  });

  it("emits formatted SSE events", () => {
    const written = [];
    const res = {
      writeHead: () => {},
      write: (chunk) => written.push(chunk),
      flush: () => {},
    };
    const emitter = new SseEventEmitter(res);

    emitter.log("info", "login", "ok", { email: "a@x.com" });
    emitter.result({ email: "a@x.com", success: true });
    emitter.done({ total: 1, success: 1, failed: 0 });

    assert.ok(written.some((w) => w.includes("event: log")));
    assert.ok(written.some((w) => w.includes("event: result")));
    assert.ok(written.some((w) => w.includes("event: done")));
  });

  it("serializes event data as JSON", () => {
    const written = [];
    const res = {
      writeHead: () => {},
      write: (chunk) => written.push(chunk),
      flush: () => {},
    };
    const emitter = new SseEventEmitter(res);

    emitter.result({ email: "a@x.com", success: true });

    const dataLine = written.find((w) => w.startsWith("data:"));
    assert.ok(dataLine);
    assert.ok(dataLine.includes('"email":"a@x.com"'));
    assert.ok(dataLine.includes('"success":true'));
  });

  it("flushes the response when flush is available", () => {
    let flushCalled = false;
    const res = {
      writeHead: () => {},
      write: () => {},
      flush: () => {
        flushCalled = true;
      },
    };
    const emitter = new SseEventEmitter(res);

    emitter.emit("log", { level: "info" });

    assert.ok(flushCalled);
  });

  it("does not throw when flush is missing", () => {
    const res = {
      writeHead: () => {},
      write: () => {},
    };
    const emitter = new SseEventEmitter(res);

    assert.doesNotThrow(() => emitter.emit("log", { level: "info" }));
  });

  it("emits structured log events with time, level, step, message and meta", () => {
    const written = [];
    const res = {
      writeHead: () => {},
      write: (chunk) => written.push(chunk),
      flush: () => {},
    };
    const emitter = new SseEventEmitter(res);

    emitter.log("warn", "validate", "check", { extra: 42 });

    const dataLine = written.find((w) => w.startsWith("data:"));
    const payload = JSON.parse(dataLine.replace("data: ", ""));
    assert.equal(payload.level, "warn");
    assert.equal(payload.step, "validate");
    assert.equal(payload.message, "check");
    assert.equal(payload.extra, 42);
    assert.ok(typeof payload.time === "string");
  });

  it("emits error events with a message", () => {
    const written = [];
    const res = {
      writeHead: () => {},
      write: (chunk) => written.push(chunk),
      flush: () => {},
    };
    const emitter = new SseEventEmitter(res);

    emitter.error("boom");

    assert.ok(written.some((w) => w.includes("event: error")));
    const dataLine = written.find((w) => w.startsWith("data:"));
    const payload = JSON.parse(dataLine.replace("data: ", ""));
    assert.equal(payload.message, "boom");
  });
});
