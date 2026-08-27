import { SSE_DONE } from "../utils/sseConstants.js";
import { FORMATS } from "../translator/formats.js";

/**
 * Should the downstream stream be run through finalizeOpenAITerminalSse?
 *
 * Applies to providers whose terminal sequence triggers OMP's OpenAI-client
 * early-break path (client sees finish+usage, cancels the still-open response,
 * gateway logs DISCONNECT: ResponseAborted, flush()/usage never runs):
 *  - tokenharbor / bai: emit finish+usage → usage-only choices:[] → [DONE] → [DONE]
 *  - antigravity: emits finish+usage mid-stream and (isGeminiFamily skip in
 *    stream.js) never sends [DONE] downstream at all
 *
 * Only normalize OpenAI-family clients: Gemini-family clients (Antigravity IDE,
 * Gemini CLI via MITM) reject the `data: [DONE]` sentinel with 400 syntax
 * errors, so leave their streams untouched.
 */
export function needsOpenAITerminalNormalization(provider, sourceFormat) {
  if (sourceFormat !== FORMATS.OPENAI) return false;
  return provider === "tokenharbor" || provider === "bai" || provider === "antigravity";
}

/**
 * Normalize downstream OpenAI SSE terminal sequences for providers that
 * emit a redundant usage-only frame and/or duplicate [DONE] sentinels.
 *
 * Token Harbor and B.AI (reasoning mode) emit:
 *   finish_reason + usage → usage-only choices:[] → [DONE] → [DONE]
 *
 * OMP sees the usage-only frame after finish_reason and deliberately breaks
 * early, cancelling the still-open HTTP response (logged as
 * "DISCONNECT: ResponseAborted"). Buffer the terminal frame, discard the
 * redundant usage-only frame, then emit one finish frame followed by one
 * [DONE] only after the transformed upstream stream closes.
 */
export function finalizeOpenAITerminalSse(readable) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let terminalFrame = null;
  let terminalUsageSeen = false;
  let upstreamDoneSeen = false;

  const emit = (controller, frame) => {
    controller.enqueue(encoder.encode(`${frame}\n\n`));
  };

  const emitDone = controller => {
    controller.enqueue(encoder.encode(SSE_DONE));
  };

  const processFrame = (frame, controller) => {
    const trimmed = frame.trim();
    if (!trimmed) return;

    if (trimmed === "data: [DONE]") {
      // Hold terminal output until upstream EOF. OMP immediately closes its
      // request body after seeing [DONE]; emitting it before the generic
      // 9router stream has drained causes ResponseAborted in the gateway log.
      upstreamDoneSeen = true;
      return;
    }

    if (!trimmed.startsWith("data:")) {
      if (!upstreamDoneSeen) emit(controller, trimmed);
      return;
    }

    const raw = trimmed.slice(5).trim();
    try {
      const event = JSON.parse(raw);
      const choices = Array.isArray(event.choices) ? event.choices : [];
      const hasFinishWithUsage = Boolean(event.usage && choices.some(choice => choice?.finish_reason));
      const isTrailingUsageOnly = Boolean(terminalUsageSeen && event.usage && choices.length === 0);

      if (hasFinishWithUsage) {
        terminalUsageSeen = true;
        terminalFrame = trimmed;
        return;
      }
      if (isTrailingUsageOnly) return;
    } catch {
      // Preserve any non-JSON SSE data unchanged.
    }

    if (!upstreamDoneSeen) emit(controller, trimmed);
  };

  return readable.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";
      for (const frame of frames) processFrame(frame, controller);
    },
    flush(controller) {
      const trailing = decoder.decode();
      if (trailing) buffer += trailing;
      if (buffer.trim()) processFrame(buffer, controller);
      if (terminalFrame) emit(controller, terminalFrame);
      // Emit exactly once, at EOF, after the generic stream fully drained.
      emitDone(controller);
    },
  }));
}
