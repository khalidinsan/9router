import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { PROVIDERS } from "../config/providers.js";
import { liftReasoningAliases } from "../translator/concerns/reasoning.js";
import { trackPendingRequest, appendRequestLog } from "@/lib/usageDb.js";
import { extractUsage, mergeUsage, hasValidUsage, estimateUsage, logUsage, addBufferToUsage, filterUsageForFormat, COLORS } from "./usageTracking.js";
import { parseSSELine, hasValuableContent, fixInvalidId, formatSSE, ensureStreamToolCallIds } from "./streamHelpers.js";
import { restoreToolNames } from "./opencodeFingerprint.js";
import { getOpenAIResponsesEventName, isOpenAIResponsesTerminalEvent, formatIncompleteOpenAIResponsesStreamFailure } from "./responsesStreamHelpers.js";
import { dbg, isDebugEnabled } from "./debugLog.js";
import { extractToolNames, fuzzyMatchToolName } from "../translator/concerns/toolCall.js";
import { normalizeNativeToolCalls, nativeToolCallParsersFor, takeEmittableContent } from "./nativeToolCalls.js";

import { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER } from "./sseConstants.js";

export { COLORS, formatSSE };
export { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER };

/**
 * Build an OpenAI-style SSE chunk that exposes structured tool_calls.
 *
 * @param {Array} toolCalls - OpenAI tool_calls array
 * @param {string} messageId - Chat completion id prefix/suffix
 * @param {string} modelName - Model name to include in the chunk
 * @returns {object}
 */
export function buildOpenAIToolCallsChunk(toolCalls, messageId, modelName) {
  const id = messageId?.startsWith("chatcmpl-") ? messageId : `chatcmpl-${messageId || Date.now()}`;
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: modelName || null,
    choices: [{
      index: 0,
      delta: { tool_calls: toolCalls.map((call, index) => ({ ...call, index })) },
      finish_reason: "tool_calls",
    }],
  };
}

/**
 * Emit a synthetic tool_calls chunk for native tool-call markup that leaked
 * into streaming content. Returns true when a chunk was emitted. No-op when
 * sourceFormat is not OpenAI.
 */
export function emitNativeToolCallsChunk(controller, toolCalls, state, modelName, sourceFormat, reqLogger) {
  if (!toolCalls || toolCalls.length === 0) return false;
  if (sourceFormat !== FORMATS.OPENAI) return false;

  const chunk = buildOpenAIToolCallsChunk(toolCalls, state?.messageId, modelName);
  const output = formatSSE(chunk, FORMATS.OPENAI);
  reqLogger?.appendConvertedChunk?.(output);
  controller.enqueue(sharedEncoder.encode(output));
  return true;
}

// sharedEncoder is stateless — safe to share across streams
const sharedEncoder = new TextEncoder();

/**
 * Stream modes
 */
const STREAM_MODE = {
  TRANSLATE: "translate",    // Full translation between formats
  PASSTHROUGH: "passthrough" // No translation, normalize output, extract usage
};

// Upper bound on the deferred response.completed wait: a chat->responses stream
// that saw finish_reason without usage must not hold the client's terminal event
// forever when the upstream stalls with no usage trailer and no [DONE].
const PENDING_COMPLETION_FLUSH_MS = 3000;

/**
 * Create unified SSE transform stream
 * @param {object} options
 * @param {string} options.mode - Stream mode: translate, passthrough
 * @param {string} options.targetFormat - Provider format (for translate mode)
 * @param {string} options.sourceFormat - Client format (for translate mode)
 * @param {string} options.provider - Provider name
 * @param {object} options.reqLogger - Request logger instance
 * @param {string} options.model - Model name
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.body - Request body (for input token estimation)
 * @param {function} options.onStreamComplete - Callback when stream completes (content, usage)
 * @param {string} options.apiKey - API key for usage tracking
 */
export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    customToolNames = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    apiKey = null,
    credentials = null
  } = options;

  let buffer = "";
  let usage = null;

  // Cache valid tool names from request body — used to correct malformed tool
  // names that weak models (e.g. Kimi served via kimchi) emit in the response
  // (e.g. "functionsread" instead of "read"). Computed once per stream.
  const validToolNames = body?.tools ? extractToolNames(body.tools) : null;

  // Tool-call ids already sent to the client, keyed by the tool-call index.
  // A late fragment that opens a NEW index without an id must not reach the
  // client as-is: strict OpenAI-compatible SDKs abort the turn on a
  // tool_call without a string id (#4992).
  const seenToolCallIds = new Map();

  // Per-stream decoder with stream:true to correctly handle multi-byte chars split across chunks
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const state = mode === STREAM_MODE.TRANSLATE
    ? { ...initState(sourceFormat), provider, toolNameMap, customToolNames: new Set(customToolNames || []), model, sessionId: credentials?._clientSessionId || null,
        // Which upstream format this stream came from. A response translator can be
        // reached either directly (target === its registered source) or as the second
        // hop of a pivot, and on the terminal null chunk the pivot drops it — so a
        // translator that defers closing events until flush needs to know which case
        // it is in. Absent/undefined means "unknown", i.e. do not defer.
        targetFormat }
    : null;

  let totalContentLength = 0;
  let accumulatedContent = "";
  let accumulatedThinking = "";
  let ttftAt = null;
  let sseLineCount = 0;
  let sseEmittedCount = 0;
  const eventTypeCounts = {};

  const nativeToolCallsEnabled = nativeToolCallParsersFor(model, body).length > 0;
  let nativeRecoveryPossible = nativeToolCallsEnabled;
  let nativeToolCallsSeen = false;
  let nativeHold = "";
  let lastNativeChunk = null;
  // A tool call's payload reaches us as one burst at the end of the generation
  // (Kiro: 119 fragments inside 12 ms, 14 s in), so a connection can sit silent
  // for minutes while the model is plainly still working. SSE comments keep it
  // provably alive without inventing content — clients ignore lines starting
  // with ':'. Emitted only after real silence, never before the first byte.
  //
  // Kiro-only on purpose: every other lane streams progressively, so a comment
  // there would be noise for no benefit.
  const KEEPALIVE_ENABLED = provider === "kiro";
  const KEEPALIVE_INTERVAL_MS = options.keepaliveIntervalMs ?? 5000;
  const KEEPALIVE_IDLE_MS = options.keepaliveIdleMs ?? KEEPALIVE_INTERVAL_MS;
  let keepaliveTimer = null;
  let lastActivityAt = Date.now();
  let streamClosed = false;
  let streamErrorSeen = false;

  // Track Responses API event framing for same-format passthrough (codex)
  let currentOpenAIResponsesEvent = null;
  let openAIResponsesTerminalSeen = false;
  let openAIResponsesDoneSent = false;
  let streamDoneSent = false;  // track duplicate [DONE] across transform + flush
  let finalized = false;
  let completionFlushTimer = null;

  // Lane quirk: upstream streams thinking under the OpenRouter aliases
  // (`reasoning` / `reasoning_details[]`) instead of reasoning_content — OpenCode
  // Free's MiMo route does. Lift it on every passthrough delta so OpenAI-shaped
  // clients, the thinking accumulation below and usage accounting see the text.
  const liftAliases = mode === STREAM_MODE.PASSTHROUGH && !!PROVIDERS[provider]?.quirks?.reasoningAliasFields;

  // Usage/logging tail, callable from transform() as well as flush(): a client that
  // closes right after the terminal event cancels the reader, and flush() never runs.
  const finalizeStream = () => {
    if (completionFlushTimer) { clearTimeout(completionFlushTimer); completionFlushTimer = null; }
    streamClosed = true;
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
    if (finalized) return;
    finalized = true;

    const isPassthrough = mode === STREAM_MODE.PASSTHROUGH;
    let finalUsage = isPassthrough ? usage : state?.usage;

    if (!hasValidUsage(finalUsage) && totalContentLength > 0) {
      finalUsage = estimateUsage(body, totalContentLength, isPassthrough ? FORMATS.OPENAI : sourceFormat);
      if (isPassthrough) usage = finalUsage; else state.usage = finalUsage;
    }

    if (hasValidUsage(finalUsage)) {
      logUsage(isPassthrough ? provider : (state?.provider || targetFormat), finalUsage, model, connectionId, apiKey);
    } else {
      appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
    }

    if (onStreamComplete) {
      onStreamComplete({
        content: accumulatedContent,
        thinking: accumulatedThinking
      }, finalUsage, ttftAt);
    }
  };

  // Emit the deferred response.completed now — at [DONE], or when the watchdog
  // below gives up on a usage trailer that never arrives.
  const flushPendingCompletion = (controller) => {
    const completed = translateResponse(targetFormat, sourceFormat, null, state);
    for (const item of completed || []) {
      if (item === null || item === undefined) continue;
      const output = formatSSE(item, sourceFormat);
      reqLogger?.appendConvertedChunk?.(output);
      controller.enqueue(sharedEncoder.encode(output));
      sseEmittedCount++;
    }
    finalizeStream();
  };
  const recoverContentDelta = (chunk) => {
    const delta = chunk.choices?.[0]?.delta;
    if (!nativeToolCallsEnabled || !delta) return false;
    const original = delta.content;
    if (delta.tool_calls?.length) {
      nativeToolCallsSeen = true;
      nativeRecoveryPossible = false;
      if (nativeHold) {
        delta.content = nativeHold + (original || "");
        nativeHold = "";
      }
    } else if (nativeRecoveryPossible && typeof original === "string") {
      const split = takeEmittableContent(nativeHold + original);
      nativeHold = split.hold;
      if (split.emit) {
        delta.content = split.emit;
        nativeRecoveryPossible = false;
      } else {
        delete delta.content;
      }
    }
    return delta.content !== original;
  };

  const resolveNativeTail = (chunk) => {
    const choice = chunk.choices?.[0];
    if (!choice || !nativeHold) return false;
    const delta = choice.delta ||= {};
    const held = nativeHold;
    nativeHold = "";
    nativeRecoveryPossible = false;
    const normalized = !streamErrorSeen && !nativeToolCallsSeen &&
      (!choice.finish_reason || choice.finish_reason === "stop" || choice.finish_reason === "tool_calls")
      ? normalizeNativeToolCalls(model, { role: "assistant", content: held }, body)
      : null;
    if (normalized) {
      delta.tool_calls = normalized.message.tool_calls.map((call, index) => ({ ...call, index }));
      choice.finish_reason = "tool_calls";
    } else {
      delta.content = held + (delta.content || "");
      totalContentLength += held.length;
      accumulatedContent += held;
    }
    return true;
  };

  const flushNativeTail = (controller) => {
    if (!lastNativeChunk || !nativeHold) return;
    const chunk = {
      id: lastNativeChunk.id,
      object: "chat.completion.chunk",
      created: lastNativeChunk.created,
      model: lastNativeChunk.model || model,
      choices: [{ index: 0, delta: {}, finish_reason: null }],
    };
    if (!resolveNativeTail(chunk)) return;
    const translated = mode === STREAM_MODE.PASSTHROUGH
      ? [chunk]
      : translateResponse(targetFormat, sourceFormat, chunk, state);
    for (const item of translated || []) {
      if (item === null || item === undefined) continue;
      const output = formatSSE(item, sourceFormat || FORMATS.OPENAI);
      reqLogger?.appendConvertedChunk?.(output);
      controller.enqueue(sharedEncoder.encode(output));
      sseEmittedCount++;
    }
  };

  const forwardStreamError = (chunk, controller) => {
    streamErrorSeen = true;
    flushNativeTail(controller);
    const output = sourceFormat === FORMATS.OPENAI_RESPONSES
      ? formatIncompleteOpenAIResponsesStreamFailure(chunk.error, state?.responseId)
      : formatSSE(sourceFormat === FORMATS.CLAUDE ? { ...chunk, type: "error" } : chunk, sourceFormat || FORMATS.OPENAI);
    reqLogger?.appendConvertedChunk?.(output);
    controller.enqueue(sharedEncoder.encode(output));
    sseEmittedCount++;
    if (sourceFormat === FORMATS.OPENAI_RESPONSES) openAIResponsesTerminalSeen = true;
    finalizeStream();
  };

  const transformer = {
    start(controller) {
      if (!KEEPALIVE_ENABLED) return;
      keepaliveTimer = setInterval(() => {
        if (streamClosed || Date.now() - lastActivityAt < KEEPALIVE_IDLE_MS) return;
        try {
          controller.enqueue(sharedEncoder.encode(": keepalive\n\n"));
          lastActivityAt = Date.now();
        } catch {
          // The consumer went away; stop trying to write to it.
          streamClosed = true;
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
      }, KEEPALIVE_INTERVAL_MS);
      keepaliveTimer?.unref?.();
    },
    transform(chunk, controller) {
      if (chunk) {
        lastActivityAt = Date.now();
        if (!ttftAt) ttftAt = Date.now();
        const text = decoder.decode(chunk, { stream: true });
        buffer += text;
        reqLogger?.appendProviderChunk?.(text);
      } else {
        buffer += "\n\n";
      }

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (isDebugEnabled && trimmed) {
          sseLineCount++;
          if (trimmed.startsWith("event:")) {
            const evt = trimmed.slice(6).trim();
            eventTypeCounts[evt] = (eventTypeCounts[evt] || 0) + 1;
          }
        }

        // Capture Responses API event name to preserve framing in same-format passthrough
        if (mode === STREAM_MODE.TRANSLATE && targetFormat === FORMATS.OPENAI_RESPONSES && trimmed.startsWith("event:")) {
          currentOpenAIResponsesEvent = trimmed.slice(6).trim();
        }

        // Passthrough mode: normalize and forward
        if (mode === STREAM_MODE.PASSTHROUGH) {
          let output;
          let injectedUsage = false;
          let responsesTerminal = false;

          if (trimmed.startsWith("data:") && trimmed.slice(5).trim() !== "[DONE]") {
            try {
              let parsed = JSON.parse(trimmed.slice(5).trim());
              if (parsed.error) {
                forwardStreamError(parsed, controller);
                continue;
              }

              const idFixed = fixInvalidId(parsed);

              // A fragment that opens a new tool-call index without an id breaks
              // strict OpenAI-compatible clients. Mint/reuse one before the
              // chunk reaches the client.
              const toolCallIdFixed = ensureStreamToolCallIds(parsed, seenToolCallIds);

              // The fingerprint pass renames a colliding caller tool to an alias
              // (read -> read_client). On this path nothing restored it, so the
              // client received a call to a tool it never declared and answered
              // "Model tried to call unavailable tool 'read_client'" (#4986).
              let toolNameRestored = false;
              if (toolNameMap?.size) {
                const restored = restoreToolNames(parsed, toolNameMap);
                if (restored !== parsed) {
                  parsed = restored;
                  toolNameRestored = true;
                }
              }

              // Ensure OpenAI-required fields are present on streaming chunks (Letta compat)
              let fieldsInjected = false;
              if (parsed.choices !== undefined) {
                if (!parsed.object) { parsed.object = "chat.completion.chunk"; fieldsInjected = true; }
                if (!parsed.created) { parsed.created = Math.floor(Date.now() / 1000); fieldsInjected = true; }
              }

              // Strip Azure-specific non-standard fields from streaming chunks
              if (parsed.prompt_filter_results !== undefined) {
                delete parsed.prompt_filter_results;
                fieldsInjected = true;
              }
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.content_filter_results !== undefined) {
                    delete choice.content_filter_results;
                    fieldsInjected = true;
                  }
                }
              }

              // Fuzzy-correct malformed tool names (e.g. "functionsread" → "read")
              // that weak models emit in delta.tool_calls[].function.name.
              if (validToolNames && validToolNames.length > 0 && Array.isArray(parsed.choices)) {
                for (const choice of parsed.choices) {
                  const delta = choice?.delta;
                  if (Array.isArray(delta?.tool_calls)) {
                    for (const tc of delta.tool_calls) {
                      if (tc.function?.name) {
                        const corrected = fuzzyMatchToolName(tc.function.name, validToolNames);
                        if (corrected !== tc.function.name) {
                          tc.function.name = corrected;
                          fieldsInjected = true;
                        }
                      }
                    }
                  }
                }
              }

              // Alias lanes: expose thinking as reasoning_content (additive) before
              // the valuable-content check, so reasoning-only chunks survive.
              if (liftAliases && parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice?.delta) {
                    const lifted = liftReasoningAliases(choice.delta);
                    if (lifted !== choice.delta) {
                      choice.delta = lifted;
                      fieldsInjected = true;
                    }
                  }
                }
              }

              // Strip empty tool_calls arrays that break AI SDK reasoning tracking.
              // Some providers (e.g. CodeBuddy CN) include `"tool_calls": []` in
              // every streaming delta. @ai-sdk/openai-compatible checks
              // `delta.tool_calls != null` — an empty array passes this check,
              // causing premature `reasoning-end` on every chunk.
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.delta?.tool_calls && Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length === 0) {
                    delete choice.delta.tool_calls;
                    fieldsInjected = true;
                  }
                }
              }
              if (!hasValuableContent(parsed, FORMATS.OPENAI)) {
                continue;
              }
              if (nativeToolCallsEnabled && parsed.choices?.[0]) lastNativeChunk = parsed;
              if (recoverContentDelta(parsed)) fieldsInjected = true;

              const delta = parsed.choices?.[0]?.delta;
              const reasoning = delta?.reasoning_content;

              const content = delta?.content;
              if (reasoning && typeof reasoning === "string") {
                totalContentLength += reasoning.length;
                accumulatedThinking += reasoning;
              }

              if (content && typeof content === "string") {
                totalContentLength += content.length;
                accumulatedContent += content;
              }

              const extracted = extractUsage(parsed);
              if (extracted) {
                usage = mergeUsage(usage, extracted);
              }

              responsesTerminal = isOpenAIResponsesTerminalEvent(currentOpenAIResponsesEvent, parsed);

              const isFinishChunk = parsed.choices?.[0]?.finish_reason;
              if (isFinishChunk && resolveNativeTail(parsed)) fieldsInjected = true;
              if (isFinishChunk && !hasValidUsage(parsed.usage)) {
                const estimated = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
                parsed.usage = filterUsageForFormat(estimated, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                usage = estimated;
                injectedUsage = true;
              } else if (isFinishChunk && usage) {
                const buffered = addBufferToUsage(usage);
                parsed.usage = filterUsageForFormat(buffered, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              } else if (idFixed || fieldsInjected || toolCallIdFixed || toolNameRestored) {
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              }
            } catch {
              // Skip non-JSON data lines silently — don't forward garbage to clients.
              // Upstream providers sometimes return plain-text errors (HTML, rate-limit
              // messages) in the SSE stream that would break downstream JSON decoders.
              continue;
            }
          }

          if (!injectedUsage) {
            if (line.startsWith("data:") && !line.startsWith("data: ")) {
              output = "data: " + line.slice(5) + "\n";
            } else {
              output = line + "\n";
            }
          }

          // The client may hang up the instant it sees the sentinel — OMP does
          // exactly that — which cancels this stream so flush() never runs and
          // the usage below is lost. Usage is already complete by the time the
          // sentinel arrives (it rides the last chunk before it), so finalize
          // here instead of waiting for a flush that may never come.
          const isDoneSentinel = trimmed.startsWith("data:") && trimmed.slice(5).trim() === "[DONE]";
          if (isDoneSentinel) {
            flushNativeTail(controller);
            streamDoneSent = true;
          }

          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          // Responses clients (codex CLI) close on response.completed instead of [DONE]
          if (responsesTerminal || isDoneSentinel) finalizeStream();
          continue;
        }

        // Translate mode
        if (!trimmed) continue;

        const parsed = parseSSELine(trimmed, targetFormat);
        if (!parsed) continue;
        if (parsed.error) {
          forwardStreamError(parsed, controller);
          continue;
        }

        // Responses API same-format passthrough: preserve event framing + track terminal state
        const isOpenAIResponsesStream = targetFormat === FORMATS.OPENAI_RESPONSES;
        const keepsOpenAIResponsesFormat = isOpenAIResponsesStream && sourceFormat === FORMATS.OPENAI_RESPONSES;
        const openAIResponsesEventName = isOpenAIResponsesStream
          ? getOpenAIResponsesEventName(currentOpenAIResponsesEvent, parsed)
          : null;

        if (isOpenAIResponsesStream && isOpenAIResponsesTerminalEvent(openAIResponsesEventName, parsed)) {
          openAIResponsesTerminalSeen = true;
        }

        // For Ollama: done=true is the final chunk with finish_reason/usage, must translate
        // For other formats: done=true is the [DONE] sentinel, skip
        if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA) {
          flushNativeTail(controller);
          // A direct Chat-to-Responses translation can defer response.completed
          // while waiting for a usage trailer. [DONE] ends that opportunity even
          // if the upstream keeps the HTTP connection open, so finish now.
          if (!streamErrorSeen && targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.OPENAI_RESPONSES &&
              state.completionPending && !state.completedSent) {
            flushPendingCompletion(controller);
          }

          // Synthesize response.failed if the Responses stream never sent a terminal event
          if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
            const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
            reqLogger?.appendConvertedChunk?.(failedOutput);
            controller.enqueue(sharedEncoder.encode(failedOutput));
            openAIResponsesTerminalSeen = true;
            sseEmittedCount++;
          }

          if ((keepsOpenAIResponsesFormat || sourceFormat === FORMATS.OPENAI) && !streamDoneSent) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }
          streamDoneSent = true;
          if (keepsOpenAIResponsesFormat) openAIResponsesDoneSent = true;
          // Same reason as the passthrough branch: a client that hangs up on the
          // sentinel cancels this stream before flush() can run, losing the usage.
          finalizeStream();
          continue;
        }
        if (nativeToolCallsEnabled && parsed.choices?.[0]) lastNativeChunk = parsed;
        recoverContentDelta(parsed);

        // Claude format - content
        if (parsed.delta?.text) {
          totalContentLength += parsed.delta.text.length;
          accumulatedContent += parsed.delta.text;
        }
        // Claude format - thinking
        if (parsed.delta?.thinking) {
          totalContentLength += parsed.delta.thinking.length;
          accumulatedThinking += parsed.delta.thinking;
        }
        
        if (parsed.choices?.[0]?.delta?.content) {
          totalContentLength += parsed.choices[0].delta.content.length;
          accumulatedContent += parsed.choices[0].delta.content;
        }
        if (parsed.choices?.[0]?.delta?.reasoning_content) {
          totalContentLength += parsed.choices[0].delta.reasoning_content.length;
          accumulatedThinking += parsed.choices[0].delta.reasoning_content;
        }
        
        // Gemini format
        if (parsed.candidates?.[0]?.content?.parts) {
          for (const part of parsed.candidates[0].content.parts) {
            if (part.text && typeof part.text === "string") {
              totalContentLength += part.text.length;
              // Check if this is thinking content
              if (part.thought === true) {
                accumulatedThinking += part.text;
              } else {
                accumulatedContent += part.text;
              }
            }
          }
        }

        // Extract usage
        const extracted = extractUsage(parsed);
        if (extracted) state.usage = mergeUsage(state.usage, extracted); // Keep original usage for logging

        // Responses same-format passthrough: re-emit with original event framing
        if (keepsOpenAIResponsesFormat && openAIResponsesEventName) {
          const output = formatSSE({ event: openAIResponsesEventName, data: parsed }, sourceFormat);
          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          currentOpenAIResponsesEvent = null;
          sseEmittedCount++;
          // Responses clients (codex) close on response.completed instead of [DONE]
          if (openAIResponsesTerminalSeen) finalizeStream();
          continue;
        }

        currentOpenAIResponsesEvent = null;
        if (parsed.choices?.[0]?.finish_reason) resolveNativeTail(parsed);

        // Translate: targetFormat -> openai -> sourceFormat
        const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

        // Log OpenAI intermediate chunks (if available)
        if (translated?._openaiIntermediate) {
          for (const item of translated._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (translated?.length > 0) {
          for (const item of translated) {
            if (item === null || item === undefined) continue;

            const isFinishChunk = item.type === "message_delta" || item.choices?.[0]?.finish_reason;

            // Filter empty chunks
            if (!hasValuableContent(item, sourceFormat)) {
              continue; // Skip this empty chunk
            }

            // Inject estimated usage if finish chunk has no valid usage
            if (state.finishReason && isFinishChunk && !hasValidUsage(item.usage) && totalContentLength > 0) {
              const estimated = estimateUsage(body, totalContentLength, sourceFormat);
              item.usage = filterUsageForFormat(estimated, sourceFormat); // Filter + already has buffer
              state.usage = estimated;
            } else if (state.finishReason && isFinishChunk && state.usage) {
              // Add buffer and filter usage for client (but keep original in state.usage for logging)
              const buffered = addBufferToUsage(state.usage);
              item.usage = filterUsageForFormat(buffered, sourceFormat);
            }

            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
            sseEmittedCount++;
          }
        }

        // The completion deferral can outlive the upstream: a broken chat upstream
        // may stall after finish_reason with no usage trailer and no [DONE], holding
        // the connection open. Bound the wait so the client still gets a terminal event.
        if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.OPENAI_RESPONSES &&
            state?.completionPending && !state?.completedSent && !completionFlushTimer) {
          completionFlushTimer = setTimeout(() => {
            completionFlushTimer = null;
            if (state?.completedSent) return;
            try { flushPendingCompletion(controller); } catch { /* controller already closed */ }
          }, PENDING_COMPLETION_FLUSH_MS);
        }
      }
    },

    flush(controller) {
      streamClosed = true;
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
      const evtSummary = Object.entries(eventTypeCounts).map(([k, v]) => `${k}=${v}`).join(",") || "none";
      dbg("SSE", `flush | provider=${provider} | model=${model} | recvLines=${sseLineCount} | emitted=${sseEmittedCount} | events=[${evtSummary}]`);
      trackPendingRequest(model, provider, connectionId, false, false, apiKey);
      try {
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;
        if (buffer) transformer.transform(null, controller);
        if (mode === STREAM_MODE.PASSTHROUGH) {
          const separator = "\n";
          reqLogger?.appendConvertedChunk?.(separator);
          controller.enqueue(sharedEncoder.encode(separator));
        }
        flushNativeTail(controller);

        if (mode === STREAM_MODE.PASSTHROUGH) {
          // IMPORTANT: In passthrough mode we still must terminate the SSE stream.
          // Some clients (e.g. OpenClaw) expect the OpenAI-style sentinel:
          //   data: [DONE]\n\n
          // Without it they can hang until timeout and trigger failover.
          // Gemini-family clients (Antigravity, Vertex, Gemini) reject this sentinel with 400 syntax errors.
          const isGeminiFamily = provider === "antigravity" || provider === "gemini" || provider === "vertex";
          if (!streamDoneSent && !isGeminiFamily) {
            const doneOutput = "data: [DONE]\n\n";
            reqLogger?.appendConvertedChunk?.(doneOutput);
            controller.enqueue(sharedEncoder.encode(doneOutput));
          }

          finalizeStream();
          return;
        }

        const flushed = streamErrorSeen ? null : translateResponse(targetFormat, sourceFormat, null, state);

        if (flushed?._openaiIntermediate) {
          for (const item of flushed._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (flushed?.length > 0) {
          for (const item of flushed) {
            if (item === null || item === undefined) continue;
            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }
        }


        // Synthesize response.failed if a Responses passthrough stream never reached a terminal event
        const keepsOpenAIResponsesFormat = targetFormat === FORMATS.OPENAI_RESPONSES && sourceFormat === FORMATS.OPENAI_RESPONSES;
        if (keepsOpenAIResponsesFormat && !openAIResponsesTerminalSeen) {
          const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
          reqLogger?.appendConvertedChunk?.(failedOutput);
          controller.enqueue(sharedEncoder.encode(failedOutput));
          openAIResponsesTerminalSeen = true;
        }

        if (keepsOpenAIResponsesFormat && !openAIResponsesDoneSent && !streamDoneSent) {
          const doneOutput = "data: [DONE]\n\n";
          reqLogger?.appendConvertedChunk?.(doneOutput);
          controller.enqueue(sharedEncoder.encode(doneOutput));
          openAIResponsesDoneSent = true;
          streamDoneSent = true;
        }

        finalizeStream();
      } catch (error) {
        console.log("Error in flush:", error);
        finalizeStream();
      }
    }
  };
  return new TransformStream(transformer);
}

export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, customToolNames = null, credentials = null) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    customToolNames,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    credentials
  });
}

export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, toolNameMap = null) {
  return createSSEStream({
    mode: STREAM_MODE.PASSTHROUGH,
    provider,
    reqLogger,
    toolNameMap,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey
  });
}
