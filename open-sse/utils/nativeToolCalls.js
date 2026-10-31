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
import { normalizeXmlInvokeToolCalls } from "./xmlInvokeToolParser.js";

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
  // Claude-family upstreams (Kiro's claude-opus-5.5* confirmed) emit
  // `<function_calls><invoke name="…">` XML. The parser only acts when an
  // `<invoke>` carries at least one `<parameter>`, so sample markup a client
  // asked the model to write stays prose.
  if (/claude|opus|sonnet|haiku/i.test(model || "")) parsers.push(normalizeXmlInvokeToolCalls);
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

// One or two fullwidth pipes (as emitted), or their ASCII stand-ins (as some
// transports normalize them).
const FENCE = `(?:${FW}{1,2}|\\|{1,2})`;

// Every token that opens or closes a marker. The leading `<` is OPTIONAL: the
// model sometimes emits the fence with the `<` already consumed by an earlier
// delta (seen in production as `|DSML| calls>`), and a bare fence must still be
// recognized or the markup leaks as prose.
//
// Both dialects nest (a wrapper around one or more calls), so these are scanned
// as a token stream and classified, rather than matched as open/close pairs. A
// single regex is required: matching opens and closes separately makes a close
// tag's inner text look like an open (`</|DSML| calls>` contains `|DSML| calls>`),
// which leaves the depth permanently above zero.
const TOKEN_RE = new RegExp(
  [
    `<?\\/?\\|tool${TB}calls?${TB}(?:begin|end)\\|>`,
    `<?\\/?${FENCE}DSML${FENCE}\\s*(?:calls|invoke)[^>]*>`,
    // The Claude/Kiro XML dialect nests the same way: a <function_calls>
    // wrapper around one or more <invoke> blocks. Treating them as tokens keeps
    // the depth counter honest, so a partially received block is held whole.
    `<function_calls>|<\\/function_calls>`,
    `<invoke\\s+name=["'][^"']*["'][^>]*>|<\\/invoke>`,
  ].join("|"),
  "g"
);

// Does this text contain markup at all? Used to decide whether a held tail is
// user-facing prose or a marker that must be dropped.
const MARKUP_LIKE = new RegExp(`(?:${FW}{1,2}|\\|{1,2})DSML|\\|tool${TB}|<function_calls>|<invoke\\s+name=`);

// Tags the XML dialect can start with. A delta that ends mid-tag (`<invo`) is
// held while it is still a prefix of one of these.
const XML_TAG_STARTS = ["<function_calls>", "<invoke", "<parameter", "<get_tool_name>"];

// A tool call's arguments are payload, not prose: a `write` carrying a whole
// file legitimately runs to hundreds of KB. The old 64 KB ceiling released the
// block as visible text once it grew past it — production leak, a 30k-token
// call whose markup reached the client. The ceiling now only guards genuinely
// malformed streams, so it must sit above real payloads.
const MAX_OPEN_MARKER_LEN = 4 * 1024 * 1024;

// A trailing fragment this short could still become a marker; longer than this
// it cannot be, so it is released as text.
const MAX_MARKER_TAIL_LEN = 64;

/** True when `text` carries any native tool-call markup. */
export function looksLikeMarkup(text) {
  return typeof text === "string" && MARKUP_LIKE.test(text);
}

/**
 * Classify a matched token as a close (true) or an open (false).
 *
 * Two close shapes exist: a DSML slash form (`</|DSML| calls>`), and the
 * token-bar `end` form (`<|tool_call_end|>`). Everything else opens.
 */
function isCloseToken(token) {
  if (/^<\//.test(token)) return true;
  if (/end\|>/.test(token)) return true;
  return false;
}

/**
 * Index of an *unterminated* marker start, or -1 when everything present is
 * either complete or plain text.
 *
 * Scans open/close tokens in stream order and tracks nesting depth: the marker
 * is open when the depth ends above zero, and it starts at the position of the
 * first unmatched open. A depth counter is required because the dialects nest —
 * "last open vs last close" would report the wrapper as closed as soon as its
 * first inner call closed, and the wrapper text would then leak.
 *
 * @param {string} text
 * @returns {number}
 */
export function findOpenMarkerStart(text) {
  if (typeof text !== "string" || !text) return -1;

  let depth = 0;
  let startAt = -1;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (isCloseToken(m[0])) {
      if (depth > 0) depth -= 1;
      // A stray close with nothing open is ignored.
      if (depth === 0) startAt = -1;
    } else {
      if (depth === 0) startAt = m.index;
      depth += 1;
    }
    // Guard against a zero-length match looping forever.
    if (m[0].length === 0) TOKEN_RE.lastIndex++;
  }

  return depth > 0 ? startAt : -1;
}

/**
 * Split `pending` into the part that is safe to emit now and the tail that must
 * be held back.
 *
 * Two things are held:
 *
 *   1. A marker, from its start to the end of the buffer, until it closes. A
 *      marker carries its whole argument payload, so this is held on identity.
 *   2. A tail that could still *become* a marker: a trailing `<`, `<` plus a
 *      fence character, or a bare fence. This one is length-bounded, since
 *      without a marker signature it is only a guess.
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

  // A bare fence (no leading `<`) is already unambiguous.
  const bare = MARKUP_LIKE.exec(pending);
  if (bare) {
    let at = bare.index;
    // A DSML token may arrive with its opener already buffered (`</|DSML|`), or
    // bare (`|DSML|`). Back up over the `<` and `/` so they are held with the
    // fence — otherwise `</` was emitted as prose before the hold kicked in.
    if (pending[at - 1] === "/" && pending[at - 2] === "<") at -= 2;
    else if (pending[at - 1] === "<") at -= 1;
    cut = at;
  }

  // A trailing `<`, `<` plus a fence character, or `<` plus `/` (itself cut from
  // `</|DSML|`) may open one next delta.
  for (let i = 0; i < pending.length; i++) {
    if (pending[i] !== "<") continue;
    const next = pending[i + 1];
    if (next === undefined || next === FW || next === "|" || (next === "/" && pending[i + 2] === undefined)) {
      if (cut === -1 || i < cut) cut = i;
      break;
    }
    // `<` + anything else is literal; keep scanning.
  }

  // A delta can also end mid-XML-tag (`<invo`), which the loop above treats as a
  // literal `<` because the next character is a letter. Hold it while the
  // fragment is still a prefix of a tag this module recognizes.
  const lastLt = pending.lastIndexOf("<");
  if (lastLt !== -1) {
    const frag = pending.slice(lastLt);
    if (!frag.includes(">") && XML_TAG_STARTS.some((t) => t.startsWith(frag) || frag.startsWith(t))) {
      if (cut === -1 || lastLt < cut) cut = lastLt;
    }
  }

  if (cut === -1) return { emit: pending, hold: "" };

  const hold = pending.slice(cut);
  // A bare fence is a real marker start, so it gets the generous bound; a lone
  // `<` is only a guess and gets the small one.
  const limit = MARKUP_LIKE.test(hold) ? MAX_OPEN_MARKER_LEN : MAX_MARKER_TAIL_LEN;
  if (hold.length > limit) return { emit: pending, hold: "" };
  return { emit: pending.slice(0, cut), hold };
}
