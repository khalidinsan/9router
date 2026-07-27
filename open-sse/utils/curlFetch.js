import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

function abortError(signal) {
  const error = new DOMException(signal?.reason?.message || "The operation was aborted", "AbortError");
  if (signal?.reason !== undefined) error.cause = signal.reason;
  return error;
}

function proxyArgs(url, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  const proxy = String(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl ?? "").trim();
  const noProxy = String(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy ?? "").trim();
  if (enabled && !proxy && proxyOptions?.strictProxy === true) {
    throw new Error("curl proxy is required when strictProxy=true");
  }

  const args = [];
  if (enabled && proxy) args.push("--proxy", proxy);
  if (noProxy) args.push("--noproxy", noProxy);
  if (proxyOptions?.strictProxy === true && !enabled) {
    throw new Error("curl proxy is disabled when strictProxy=true");
  }
  return args;
}

function parseHeaders(raw) {
  const blocks = raw.split(/\r?\n\r?\n/).filter((block) => /^HTTP\/\S+\s+\d{3}/i.test(block));
  const block = blocks.at(-1);
  if (!block) throw new Error("curl returned no HTTP response headers");

  const lines = block.split(/\r?\n/);
  const match = lines.shift().match(/^HTTP\/\S+\s+(\d{3})(?:\s+(.*))?$/i);
  if (!match) throw new Error("curl returned malformed HTTP status");
  const headers = new Headers();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return { status: Number(match[1]), statusText: match[2] || "", headers };
}

/** A streaming fetch-compatible adapter backed by the system curl binary. */
export async function curlFetch(url, options = {}, proxyOptions = {}) {
  const target = String(url);
  const signal = options.signal;
  if (signal?.aborted) throw abortError(signal);

  const directory = await mkdtemp(join(tmpdir(), "9router-curl-"));
  const headerFile = join(directory, "headers");
  const method = String(options.method || (options.body == null ? "GET" : "POST")).toUpperCase();
  const args = ["--silent", "--show-error", "--no-buffer", "--request", method, "--dump-header", headerFile, "--output", "-"];
  const headers = new Headers(options.headers || {});
  for (const [name, value] of headers) args.push("--header", `${name}: ${value}`);
  if (options.timeout != null) args.push("--max-time", String(Math.max(0.001, Number(options.timeout) / 1000)));
  args.push(...proxyArgs(target, proxyOptions));
  if (options.body != null) args.push("--data-binary", "@-");
  args.push("--", target);

  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    let stderr = "";

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      void rm(directory, { recursive: true, force: true });
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      if (!settled) fail(abortError(signal));
      else child.stdout.destroy(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    child.on("error", fail);

    const resolveResponse = async () => {
      if (settled) return;
      try {
        const parsed = parseHeaders(await readFile(headerFile, "utf8"));
        settled = true;
        const body = method === "HEAD" || [101, 204, 205, 304].includes(parsed.status)
          ? null
          : Readable.toWeb(child.stdout);
        resolve(new Response(body, parsed));
        child.once("close", cleanup);
      } catch (error) {
        fail(error);
        child.kill("SIGTERM");
      }
    };

    child.stdout.once("readable", resolveResponse);
    child.once("close", (code, exitSignal) => {
      if (!settled) {
        if (code === 0) resolveResponse();
        else fail(new Error(`curl exited with code ${code ?? exitSignal}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
      }
    });

    if (options.body == null) child.stdin.end();
    else if (typeof options.body === "string" || Buffer.isBuffer(options.body) || options.body instanceof Uint8Array) child.stdin.end(options.body);
    else if (options.body instanceof ArrayBuffer) child.stdin.end(Buffer.from(options.body));
    else fail(new TypeError("curlFetch body must be a string, Buffer, Uint8Array, or ArrayBuffer"));
  });
}

export default curlFetch;
