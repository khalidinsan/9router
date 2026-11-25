import { FORMATS } from "../../translator/formats.js";

// Endpoints whose wire format has no non-streaming variant.
const ALWAYS_STREAM_FORMATS = new Set([
  FORMATS.ANTIGRAVITY,
  FORMATS.GEMINI,
  FORMATS.GEMINI_CLI,
]);

/**
 * Decide whether this request streams downstream.
 *
 * OpenAI and Anthropic both default `stream` to false when the field is absent,
 * and SDKs routinely omit it for non-streaming calls. Treating "absent" as
 * streaming labelled a plain JSON body as `text/event-stream` (with a trailing
 * `data: [DONE]`), which broke every JSON parser on the client — so absent now
 * falls back to the format's default, not to streaming.
 */
export function resolveStreamIntent({ body, sourceFormat, providerRequiresStreaming = false, acceptHeader = "" }) {
  if (providerRequiresStreaming) return true;

  if (body?.stream === true) return true;
  if (body?.stream === false) return false;

  const prefersJson = acceptHeader.includes("application/json");
  const prefersSse = acceptHeader.includes("text/event-stream");
  if (prefersJson && !prefersSse) return false;
  if (prefersSse && !prefersJson) return true;

  return ALWAYS_STREAM_FORMATS.has(sourceFormat);
}
