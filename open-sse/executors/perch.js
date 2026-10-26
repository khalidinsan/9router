import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import {
  PERCH_APP_URL,
  PERCH_TICKET_PATH,
  PERCH_MODEL_CALL_PATH,
  PERCH_AUTH_CONFIG_PATH,
  PERCH_TICKET_HEADER,
  PERCH_LOCALE_HEADER,
  PERCH_CALL_DELTA_HEADER,
  PERCH_SYSTEM_MARKER,
  PERCH_TICKET_TTL_MS,
  PERCH_TICKET_RENEW_BEFORE_MS,
  perchUserAgent,
  perchAttribution,
  perchCredentialFrom,
  perchRateLimitWaitMs,
  PERCH_MINT_MAX_WAIT_MS,
} from "../config/perch.js";
import { randomUUID } from "node:crypto";

/**
 * PerchExecutor — talks to the Perch Terminal app backend.
 *
 * Two calls per turn (see config/perch.js for the captured wire):
 *   1. POST /api/perch-terminal/turn-ticket  → { ticket, runId }
 *   2. POST /api/perch-terminal/model-call   → SSE of Perch's own event shapes
 *
 * Perch's SSE is not OpenAI's: it emits `answer_delta`, `reasoning_delta`,
 * `tool_call_delta`, `tool_use_end` and a terminal `done` carrying the full
 * text + usage. This executor translates that to OpenAI chat.completion.chunk
 * frames (stream) or one chat.completion object (non-stream), so everything
 * downstream in the gateway — translators, usage accounting, tool loop — works
 * unchanged.
 *
 * The public model slugs are mapped here to the backend option ids the route
 * resolves; sending an unknown option id silently falls back to the account's
 * Roost default, which is why the mapping is explicit rather than passthrough.
 */

const MODEL_OPTION_IDS = {
  "deepseek-v4.1-flash": "openrouter-deepseek-deepseek-v4-1-flash",
  "glm-5.3-flash": "openrouter-z-ai-glm-5-3-flash",
  "laguna-s": "poolside-poolside-laguna-s-2-1",
};

// Roost tier → the route's own effort vocabulary.
const EFFORT_LEVELS = new Set(["off", "low", "medium", "high", "xhigh", "max", "ultra"]);

function effortDirective(body) {
  const raw = body?.reasoning_effort ?? body?.effort;
  const level = typeof raw === "string" && EFFORT_LEVELS.has(raw) ? raw : "high";
  return { level, orchestration: false };
}

/** Inject the >=200-char system marker the surface gate requires (idempotent). */
function ensureSystemMarker(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const idx = messages.findIndex((m) => m?.role === "system");
  if (idx === -1) {
    return { ...body, messages: [{ role: "system", content: PERCH_SYSTEM_MARKER }, ...messages] };
  }
  const existing = messages[idx];
  const text = typeof existing.content === "string" ? existing.content : "";
  if (text.length >= PERCH_SYSTEM_MARKER.length) return body;
  const merged = text.trim() ? `${text}\n\n${PERCH_SYSTEM_MARKER}` : PERCH_SYSTEM_MARKER;
  const next = messages.slice();
  next[idx] = { ...existing, content: merged };
  return { ...body, messages: next };
}

/** OpenAI tools → Perch's `request.tools` (already the same shape). */
function perchRequest(body, model) {
  const req = {
    messages: body.messages,
  };
  if (Array.isArray(body.tools) && body.tools.length) req.tools = body.tools;
  if (typeof body.temperature === "number") req.temperature = body.temperature;
  if (typeof body.max_tokens === "number") req.maxTokens = body.max_tokens;
  else if (typeof body.max_completion_tokens === "number") req.maxTokens = body.max_completion_tokens;
  if (body.tool_choice) req.toolChoice = body.tool_choice;
  if (body.response_format?.type === "json_object") req.responseFormat = { type: "json_object" };
  return req;
}

function parseSseBlock(block) {
  const line = block.split("\n").find((l) => l.startsWith("data:"));
  if (!line) return null;
  const raw = line.slice(5).trim();
  if (!raw || raw === "[DONE]") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export class PerchExecutor extends BaseExecutor {
  constructor() {
    super("perch", PROVIDERS["perch"]);
  }

  buildUrl() {
    return `${PERCH_APP_URL}${PERCH_MODEL_CALL_PATH}`;
  }

  buildHeaders(credentials, stream = true) {
    const { accessToken: token } = perchCredentialFrom(credentials);
    const headers = {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      "User-Agent": perchUserAgent(),
      [PERCH_LOCALE_HEADER]: "en",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  /**
   * Mint a ticket for one runId. Tickets are bound to the run they were issued
   * for, so the caller must send the returned runId in the body.
   *
   * The mint route is rate limited per account and answers 429 with a short
   * reset window (observed 4–8s). Surfacing that to the gateway would lock the
   * account and back the model off for minutes over a few seconds of upstream
   * pacing, so wait it out here instead: up to PERCH_MINT_MAX_WAIT_MS total.
   */
  async mintTicket(credentials, log, proxyOptions) {
    const { accessToken: token } = perchCredentialFrom(credentials);
    const request = () =>
      proxyAwareFetch(
        `${PERCH_APP_URL}${PERCH_TICKET_PATH}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "User-Agent": perchUserAgent(),
            [PERCH_LOCALE_HEADER]: "en",
          },
          body: JSON.stringify({ surface: "cli", profile: "standard" }),
        },
        proxyOptions
      );

    const deadline = Date.now() + PERCH_MINT_MAX_WAIT_MS;
    let response = await request();
    while (response.status === 429 && Date.now() < deadline) {
      const text = await response.text().catch(() => "");
      const waitMs = perchRateLimitWaitMs(text, deadline);
      log?.debug?.("AUTH", `Perch mint 429; waiting ${waitMs}ms for the turn window`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      response = await request();
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      log?.error?.("AUTH", `Perch ticket mint failed: ${response.status} ${text.slice(0, 200)}`);
      return { error: "ticket", status: response.status, message: text.slice(0, 200) };
    }
    const payload = await response.json().catch(() => null);
    if (!payload?.ok || !payload.ticket || !payload.runId) {
      log?.error?.("AUTH", `Perch ticket mint returned no ticket: ${JSON.stringify(payload).slice(0, 200)}`);
      return { error: "ticket", status: 502, message: "Perch returned no ticket" };
    }
    const expiresAt = payload.expiresAt ? Date.parse(payload.expiresAt) : Date.now() + PERCH_TICKET_TTL_MS;
    return {
      ticket: payload.ticket,
      runId: payload.runId,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + PERCH_TICKET_TTL_MS,
    };
  }

  buildModelCallBody(body, model, ticket) {
    const optionId = MODEL_OPTION_IDS[model];
    const payload = {
      request: perchRequest(body, model),
      runId: ticket.runId,
      lane: "chat",
      strictManual: false,
      preferredModelId: null,
      avoidModelIds: [],
      attribution: perchAttribution({
        userId: null,
        workspaceId: null,
        runId: ticket.runId,
        lane: "chat",
        surface: "cli",
      }),
      clientSurface: "cli",
      roostModelChoice: "standard",
      roostReasoning: true,
      effort: effortDirective(body),
    };
    if (optionId) payload.manualModelOptionId = optionId;
    return payload;
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const { accessToken: token } = perchCredentialFrom(credentials);
    if (!token) {
      return {
        response: new Response(
          JSON.stringify({ error: { message: "Perch requires a Perch CLI session token.", type: "api_error" } }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        ),
        url: this.buildUrl(),
        headers: {},
        transformedBody: body,
      };
    }

    const prepared = ensureSystemMarker(body);
    const ticket = await this.mintTicket(credentials, log, proxyOptions);
    if (!ticket || ticket.error) {
      const status = ticket?.status && ticket.status >= 400 ? ticket.status : 502;
      return {
        response: new Response(
          JSON.stringify({
            error: {
              message:
                status === 401
                  ? "Perch session rejected. Re-run `perch login` and update the connection."
                  : `Perch could not start a turn: ${ticket?.message || "ticket unavailable"}`,
              type: status === 429 ? "rate_limit_error" : "api_error",
              code: "perch_ticket_unavailable",
            },
          }),
          { status, headers: { "Content-Type": "application/json" } }
        ),
        url: this.buildUrl(),
        headers: {},
        transformedBody: prepared,
      };
    }

    const url = this.buildUrl();
    const headers = {
      ...this.buildHeaders(credentials, true),
      [PERCH_CALL_DELTA_HEADER]: "1",
      [PERCH_TICKET_HEADER]: ticket.ticket,
    };
    const payload = this.buildModelCallBody(prepared, model, ticket);
    const bodyStr = JSON.stringify(payload);
    log?.debug?.("FETCH", `PERCH → ${url} | model=${model} | run=${ticket.runId} | body=${bodyStr.length}B`);

    const response = await proxyAwareFetch(
      url,
      { method: "POST", headers, body: bodyStr, signal },
      proxyOptions
    );

    if (!response.ok) {
      // Surface Perch's own error envelope so the gateway can classify it.
      const text = await response.text().catch(() => "");
      log?.warn?.("FETCH", `PERCH ← ${response.status} ${text.slice(0, 200)}`);
      return {
        response: new Response(
          JSON.stringify({
            error: {
              message: perchErrorMessage(response.status, text),
              type: response.status === 429 ? "rate_limit_error" : "api_error",
              code: "perch_error",
            },
          }),
          { status: response.status, headers: { "Content-Type": "application/json" } }
        ),
        url,
        headers,
        transformedBody: payload,
      };
    }

    const translated = stream === false
      ? await this.collectFullResponse(response, model)
      : this.toOpenAIStream(response, model);

    return { response: translated, url, headers, transformedBody: payload };
  }

  /** Perch SSE → OpenAI chat.completion.chunk SSE. */
  toOpenAIStream(response, model) {
    const enc = new TextEncoder();
    const decoder = new TextDecoder();
    const id = `chatcmpl-perch-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const frame = (delta, finish = null, extra = {}) =>
      enc.encode(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...extra,
        })}\n\n`
      );

    const self = this;
    const upstream = response.body;
    const out = new ReadableStream({
      async start(controller) {
        const reader = upstream.getReader();
        let buffer = "";
        let sentRole = false;
        // Tool-call arguments stream as cumulative rawArgumentsText per call id.
        const toolArgsSent = new Map();
        const toolIndex = new Map();
        let nextToolIndex = 0;
        let usage = null;

        const emitRole = () => {
          if (sentRole) return;
          sentRole = true;
          controller.enqueue(frame({ role: "assistant" }));
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split("\n\n");
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
              const ev = parseSseBlock(block);
              if (!ev) continue;

              if (ev.type === "answer_delta" && typeof ev.text === "string") {
                emitRole();
                controller.enqueue(frame({ content: ev.text }));
                continue;
              }
              if (ev.type === "reasoning_delta" && typeof ev.text === "string") {
                emitRole();
                controller.enqueue(frame({ reasoning_content: ev.text }));
                continue;
              }
              if ((ev.type === "tool_call_delta" || ev.type === "tool_use_end") && Array.isArray(ev.toolCalls)) {
                emitRole();
                for (const call of ev.toolCalls) {
                  if (!call?.id) continue;
                  if (!toolIndex.has(call.id)) {
                    toolIndex.set(call.id, nextToolIndex++);
                    controller.enqueue(
                      frame({
                        tool_calls: [
                          {
                            index: toolIndex.get(call.id),
                            id: call.id,
                            type: "function",
                            function: { name: call.name || "", arguments: "" },
                          },
                        ],
                      })
                    );
                    toolArgsSent.set(call.id, "");
                  }
                  // Perch streams cumulative JSON in rawArgumentsText; `arguments`
                  // is only populated once the fragment parses, and an empty
                  // fragment must not be sent as "{}" or the prefix check breaks.
                  const full = typeof call.rawArgumentsText === "string"
                    ? call.rawArgumentsText
                    : call.sealed && call.arguments && typeof call.arguments === "object"
                      ? JSON.stringify(call.arguments)
                      : "";
                  if (!full) continue;
                  const already = toolArgsSent.get(call.id) || "";
                  if (full === already) continue;
                  const delta = full.startsWith(already) ? full.slice(already.length) : full;
                  toolArgsSent.set(call.id, full);
                  controller.enqueue(
                    frame({
                      tool_calls: [
                        {
                          index: toolIndex.get(call.id),
                          function: { arguments: delta },
                        },
                      ],
                    })
                  );
                }
                continue;
              }
              if (ev.type === "done") {
                usage = self.mapUsage(ev.usage);
                if (ev.ok === false) {
                  controller.enqueue(
                    enc.encode(
                      `data: ${JSON.stringify({ error: { message: String(ev.error || "Perch model call failed"), type: "api_error" } })}\n\n`
                    )
                  );
                  continue;
                }
                const finish = toolIndex.size > 0 ? "tool_calls" : "stop";
                emitRole();
                // Usage rides the finish chunk: the gateway's translator reads it
                // there to avoid replacing real counts with its own estimate.
                controller.enqueue(frame({}, finish, usage ? { usage } : {}));
                continue;
              }
              // stream_restart / continuation_seam / model_call_failed / error are
              // transport chatter: the final `done` carries the authoritative text.
              if (ev.type === "error") {
                controller.enqueue(
                  enc.encode(
                    `data: ${JSON.stringify({ error: { message: String(ev.message || "Perch stream error"), type: "api_error" } })}\n\n`
                  )
                );
              }
            }
          }
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          reader.releaseLock?.();
        }
      },
    });

    return new Response(out, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  /** Non-streaming client: read the whole SSE and emit one chat.completion. */
  async collectFullResponse(response, model) {
    const text = await response.text();
    let content = "";
    let reasoning = "";
    let finish = "stop";
    let usage = null;
    let failure = null;
    const toolCalls = [];
    const argsByCall = new Map();

    for (const block of text.split("\n\n")) {
      const ev = parseSseBlock(block);
      if (!ev) continue;
      if (ev.type === "answer_delta" && typeof ev.text === "string") content += ev.text;
      else if (ev.type === "reasoning_delta" && typeof ev.text === "string") reasoning += ev.text;
      else if ((ev.type === "tool_call_delta" || ev.type === "tool_use_end") && Array.isArray(ev.toolCalls)) {
        for (const call of ev.toolCalls) {
          if (!call?.id) continue;
          if (!argsByCall.has(call.id)) {
            argsByCall.set(call.id, { id: call.id, name: call.name || "", arguments: "" });
            toolCalls.push(argsByCall.get(call.id));
          }
          const entry = argsByCall.get(call.id);
          if (call.name) entry.name = call.name;
          const raw = typeof call.rawArgumentsText === "string"
            ? call.rawArgumentsText
            : call.sealed && call.arguments && typeof call.arguments === "object"
              ? JSON.stringify(call.arguments)
              : "";
          if (raw) entry.arguments = raw;
        }
      } else if (ev.type === "done") {
        usage = this.mapUsage(ev.usage);
        if (ev.ok === false) failure = String(ev.error || "Perch model call failed");
        if (typeof ev.text === "string" && ev.text) content = ev.text;
        if (toolCalls.length) finish = "tool_calls";
      }
    }

    if (failure) {
      return new Response(
        JSON.stringify({ error: { message: failure, type: "api_error", code: "perch_error" } }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const message = { role: "assistant", content: content || null };
    if (reasoning) message.reasoning_content = reasoning;
    if (toolCalls.length) {
      message.tool_calls = toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments || "{}" },
      }));
    }

    return new Response(
      JSON.stringify({
        id: `chatcmpl-perch-${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  mapUsage(raw) {
    if (!raw || typeof raw !== "object") return null;
    const prompt = Number(raw.inputTokens ?? raw.prompt_tokens ?? raw.input_tokens ?? 0);
    const completion = Number(raw.outputTokens ?? raw.completion_tokens ?? raw.output_tokens ?? 0);
    const total = Number(raw.totalTokens ?? raw.total_tokens ?? prompt + completion);
    if (!prompt && !completion && !total) return null;
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total || prompt + completion,
    };
  }
}

/** Map Perch's refusal envelope to something a client can act on. */
function perchErrorMessage(status, raw) {
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    // non-JSON body: fall through to the generic message
  }
  const message = payload?.error || raw.slice(0, 300) || `Perch returned HTTP ${status}`;
  if (status === 403 && payload?.errorCode === "perch_surface_required") {
    return `${message} (Perch refused the request as direct API access.)`;
  }
  if (status === 429) return `Perch rate limit or plan allowance reached: ${message}`;
  return message;
}

export const __test__ = { MODEL_OPTION_IDS, ensureSystemMarker, perchRequest, effortDirective };

export default PerchExecutor;
