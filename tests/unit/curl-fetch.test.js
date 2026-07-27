import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { curlFetch } from "../../open-sse/utils/curlFetch.js";

const servers = [];

async function listen(handler) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("curlFetch", () => {
  it("sends the body through stdin and returns status, repeated headers, and body", async () => {
    const base = await listen(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      res.writeHead(201, {
        "content-type": "text/plain",
        "x-request-method": req.method,
        "set-cookie": ["a=1", "b=2"],
      });
      res.end(Buffer.concat(chunks));
    });

    const response = await curlFetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer super-secret" },
      body: '{"hello":"world"}',
    }, { noProxy: "127.0.0.1" });

    expect(response.status).toBe(201);
    expect(response.headers.get("x-request-method")).toBe("POST");
    expect(response.headers.get("set-cookie")).toContain("a=1");
    expect(await response.text()).toBe('{"hello":"world"}');
  });

  it("exposes response bytes as a stream before the response completes", async () => {
    let finish;
    const base = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("first\n");
      finish = () => res.end("second\n");
    });

    const response = await curlFetch(`${base}/stream`);
    const reader = response.body.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("first\n");
    finish();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe("second\n");
  });

  it("terminates curl and rejects with AbortError", async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      setTimeout(() => res.end("late"), 2_000);
    });
    const controller = new AbortController();
    const pending = curlFetch(`${base}/slow`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails closed when strict proxy is requested without a proxy", async () => {
    await expect(curlFetch("http://127.0.0.1/", {}, { strictProxy: true }))
      .rejects.toThrow(/proxy/i);
  });
});
