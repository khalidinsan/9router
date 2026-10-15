/**
 * Registry of native tool-call markup dialects.
 *
 * Several model families emit their native token-based tool-call format as
 * plain assistant `content` instead of populating the structured OpenAI
 * `tool_calls` array. Each family has its own dialect and its own parser:
 *
 *  - Kimi K2.x  -> `functions.NAME:ID {json}`   (utils/kimiToolParser.js)
 *  - DeepSeek   -> DSML `<|DSML| invoke ...>` and the raw `<|tool_call_begin|>`
 *                 token-bar form                (utils/deepseekToolParser.js)
 *
 * Both the streaming path (utils/stream.js) and the non-streaming paths
 * (handlers/chatCore/nonStreamingHandler.js, sseToJsonHandler.js) need the same
 * dispatch, so it lives in this leaf module: importing it from stream.js would
 * make the handlers depend on the stream module, which tests mock wholesale.
 */

import { normalizeKimiToolCalls } from "./kimiToolParser.js";
import { normalizeDeepseekToolCalls } from "./deepseekToolParser.js";

/**
 * Which parsers apply to `model`, in priority order.
 *
 * @param {string} model
 * @returns {Array<function>} parsers taking/returning `{message, hasTools}`
 */
export function nativeToolCallParsersFor(model) {
  const parsers = [];
  if (/kimi-k2\./i.test(model || "")) parsers.push(normalizeKimiToolCalls);
  // DeepSeek V4.x, including the `:free` tiers on Token Harbor and WorkBuddy.
  if (/deepseek/i.test(model || "")) parsers.push(normalizeDeepseekToolCalls);
  return parsers;
}

/**
 * Apply the native tool-call parsers for `model` to a message whose `content`
 * may have leaked raw markup.
 *
 * @param {string} model
 * @param {{content?: string}} message
 * @returns {{message: object, hasTools: boolean}|null} the first parser result
 *   that found tools, or null when none matched.
 */
export function normalizeNativeToolCalls(model, message) {
  for (const parse of nativeToolCallParsersFor(model)) {
    const result = parse(message);
    if (result?.hasTools) return result;
  }
  return null;
}

// --- Streaming holdback -----------------------------------------------------
//
// Markup is routinely split across SSE deltas, so a delta can end mid-marker
// (`<|tool`) and testing it in isolation misses the call entirely. Worse, the
// parsers deliberately tolerate a missing end tag (a truncated capture is still
// worth recovering), so an in-flight call would parse with *partial* arguments
// and the remainder would be forwarded to the client as prose. The helpers below
// decide which tail must be withheld until the marker closes.

// U+2581 LOWER ONE EIGHTH BLOCK, the raw special-token separator.
const TB = "\u2581";
// U+FF5C FULLWIDTH VERTICAL LINE, the DSML fence.
const FW = "\uFF5C";

// A native marker always begins with `<` followed by U+FF5C or `|`. Anything
// else after `<` is ordinary text ("a < b"), so only these force a holdback.
const FENCE_CHARS = new Set([FW, "|"]);

// One or two fullwidth pipes (as emitted), or their ASCII stand-ins (as some
// transports normalize them).
const FENCE = `(?:${FW}{1,2}|\\|{1,2})`;

const TOKENBAR_START = new RegExp(`<\\|tool${TB}call${TB}begin\\|>`, "g");
const TOKENBAR_END = new RegExp(`<\\|tool${TB}call${TB}end\\|>`, "g");
const TOKENBAR_CALLS_START = new RegExp(`<\\|tool${TB}calls${TB}begin\\|>`, "g");
const TOKENBAR_CALLS_END = new RegExp(`<\\|tool${TB}calls${TB}end\\|>`, "g");
const DSML_INVOKE_START = new RegExp(`<${FENCE}DSML${FENCE}\\s*invoke\\s+name=`, "g");
const DSML_INVOKE_END = new RegExp(`<\\/${FENCE}DSML${FENCE}\\s*invoke>`, "g");

// A trailing fragment this short could still be the start of a marker; longer
// than this it cannot be, so it is released as text.
const MAX_MARKER_TAIL_LEN = 64;

// A confirmed open marker is held until it closes, bounded so a malformed
// stream cannot pin unbounded memory.
const MAX_OPEN_MARKER_LEN = 64 * 1024;

/** Start index of the last match of a global regex, or -1 when it never matches. */
function lastMatchStart(re, text) {
  re.lastIndex = 0;
  let at = -1;
  let m;
  while ((m = re.exec(text)) !== null) {
    at = m.index;
    // Guard against a zero-length match looping forever.
    if (m[0].length === 0) re.lastIndex++;
  }
  return at;
}

/**
 * Index of an *unterminated* marker start, or -1 when everything present is
 * either complete or plain text.
 *
 * The wrapper `<|tool_calls_begin|>` is checked first: a call inside it is still
 * open until its own end tag arrives, and the wrapper stays open until
 * `calls_end`. Holding from the wrapper start covers both, so the partial
 * arguments of an in-flight call can never be forwarded as prose.
 *
 * @param {string} text
 * @returns {number}
 */
export function findOpenMarkerStart(text) {
  if (typeof text !== "string" || !text) return -1;

  const callsStart = lastMatchStart(TOKENBAR_CALLS_START, text);
  if (callsStart !== -1) {
    const callsEnd = lastMatchStart(TOKENBAR_CALLS_END, text);
    if (callsEnd < callsStart) return callsStart;
  }

  let open = -1;
  const tbStart = lastMatchStart(TOKENBAR_START, text);
  if (tbStart !== -1) {
    const tbEnd = lastMatchStart(TOKENBAR_END, text);
    if (tbEnd < tbStart) open = tbStart;
  }

  const dsmlStart = lastMatchStart(DSML_INVOKE_START, text);
  if (dsmlStart !== -1) {
    const dsmlEnd = lastMatchStart(DSML_INVOKE_END, text);
    if (dsmlEnd < dsmlStart && (open === -1 || dsmlStart < open)) open = dsmlStart;
  }

  return open;
}

/**
 * Split `pending` into the part that is safe to emit now and the tail that must
 * be held back.
 *
 * Two things are held:
 *
 *   1. An open marker, from its start to the end of the buffer, until the
 *      terminating token arrives. A marker carries its whole argument payload,
 *      so this is held on identity, not length.
 *   2. A tail that could still *become* a marker: a trailing `<`, or `<` plus a
 *      fence character. This one is length-bounded, since without a marker
 *      signature it is only a guess.
 *
 * Content with neither is returned whole, so ordinary responses stream through
 * untouched.
 *
 * @param {string} pending
 * @returns {{emit: string, hold: string}}
 */
export function takeEmittableContent(pending) {
  if (!pending) return { emit: "", hold: "" };

  // 1. An unterminated marker: hold from its start.
  const openAt = findOpenMarkerStart(pending);
  if (openAt !== -1) {
    if (pending.length - openAt <= MAX_OPEN_MARKER_LEN) {
      return { emit: pending.slice(0, openAt), hold: pending.slice(openAt) };
    }
    // Malformed beyond recovery: release so the stream cannot stall.
    return { emit: pending, hold: "" };
  }

  // 2. A tail that may still begin a marker.
  let cut = -1;
  for (let i = 0; i < pending.length; i++) {
    if (pending[i] !== "<") continue;
    const next = pending[i + 1];
    // `<` at the very end: the next delta decides whether it starts a marker.
    // `<` + fence char: may be a marker.
    if (next === undefined || FENCE_CHARS.has(next)) {
      cut = i;
      break;
    }
    // `<` + anything else is literal; keep scanning.
  }

  if (cut === -1) return { emit: pending, hold: "" };

  const hold = pending.slice(cut);
  if (hold.length > MAX_MARKER_TAIL_LEN) return { emit: pending, hold: "" };
  return { emit: pending.slice(0, cut), hold };
}
