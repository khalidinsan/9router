/**
 * Native DeepSeek tool-call markup parser.
 *
 * DeepSeek V4.1 Flash (and the V4 family generally) occasionally emits its
 * native token-based tool-call format as plain assistant `content` instead of
 * populating the structured OpenAI `tool_calls` array. The client then renders
 * the raw markup as text and never runs the tool.
 *
 * Two distinct markups have been observed in production traffic, from the same
 * model family through different gateways:
 *
 * 1. DSML — DeepSeek's documented XML-ish dialect, fenced with U+FF5C FULLWIDTH
 *    VERTICAL LINE (`｜`). The fence is emitted with ONE pipe per side by
 *    Token Harbor and with TWO by WorkBuddy, so both widths are accepted:
 *
 *      <｜DSML｜ calls>                      <｜｜DSML｜｜ calls>
 *      <｜DSML｜ invoke name="read">          <｜｜DSML｜｜ invoke name="read">
 *      <｜DSML｜ parameter name="path" ...>   <｜｜DSML｜｜ parameter name="path" ...>
 *
 *    A malformed `calls_begin` spelling also appears, and the close tag is
 *    sometimes dropped entirely.
 *
 * 2. Token-bar — the raw special-token form, using U+2581 LOWER ONE EIGHTH
 *    BLOCK (`▁`) as the separator:
 *
 *      <|tool▁calls▁begin|><|tool▁call▁begin|>read<|tool▁sep|>{"path":"package.json"}|tool▁call▁end|>
 *
 *    The model sometimes continues into a hallucinated `<|tool▁output▁begin|>`
 *    block; everything from that marker onward is discarded.
 *
 * Both shapes normalize to the same OpenAI tool_calls item:
 *
 *   { id: string, type: "function", function: { name: string, arguments: string } }
 *
 * The parser is intentionally conservative and total: it returns `hasTools:false`
 * and the untouched message when nothing matches, never throws on malformed
 * input, and caps extraction at MAX_CALLS.
 */

import { generateToolCallId } from "../translator/concerns/toolCall.js";

const MAX_CALLS = 64;

// U+FF5C FULLWIDTH VERTICAL LINE, the DSML fence.
const FW = "\uFF5C";
// U+2581 LOWER ONE EIGHTH BLOCK, the raw special-token separator.
const TB = "\u2581";

// One or two fullwidth pipes (as emitted), or their ASCII stand-ins (as some
// transports normalize them).
const FENCE = `(?:${FW}{1,2}|\\|{1,2})`;

// Precompiled detectors — non-global so `.test()` carries no lastIndex state.
// These run on every content delta, so they must not allocate.
const DSML_DETECT = new RegExp(`<${FENCE}DSML${FENCE}`);
const TOKENBAR_DETECT = new RegExp(`<\\|tool[${TB}_]`);

/** True when `content` carries either native DeepSeek tool-call markup. */
export function hasDeepseekToolMarkup(content) {
  if (typeof content !== "string" || content.length === 0) return false;
  return DSML_DETECT.test(content) || TOKENBAR_DETECT.test(content);
}

/** Strip a tool name of the trailing namespace some gateways prepend. */
function cleanToolName(name) {
  return String(name || "").trim().replace(/^functions\./, "");
}

/** Coerce a parameter's text into a JSON value: objects stay objects, scalars get typed. */
function coerceParamValue(raw) {
  const text = String(raw ?? "");
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed[0] === "{" || trimmed[0] === "[" || trimmed === "true" || trimmed === "false" || trimmed === "null") {
    try {
      return JSON.parse(trimmed);
    } catch {
      return text;
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return text;
}

/**
 * Drop any residual tool-call fence left inside an argument payload. The end
 * tags are unreliable and the `<|` prefix is normalized inconsistently, so a
 * stray `|tool▁call▁end|>` can survive the terminator search and break
 * JSON.parse downstream.
 */
function stripResidualFences(text) {
  return String(text ?? "")
    .replace(new RegExp(`<?\\|tool${TB}[a-z_]+(?:${TB}[a-z_]+)?\\|>?`, "g"), "")
    .replace(new RegExp(`<?\\|tool_[a-z_]+(?:_[a-z_]+)?\\|>?`, "g"), "")
    .trim();
}

/**
 * Parse the DSML dialect (both fence widths).
 *
 * @param {string} content
 * @returns {Array<{id:string,type:"function",function:{name:string,arguments:string}}>}
 */
function parseDsml(content) {
  const calls = [];
  const openRe = new RegExp(`<${FENCE}DSML${FENCE}\\s*invoke\\s+name=["']([^"']+)["'][^>]*>`, "g");
  const paramRe = new RegExp(
    `<${FENCE}DSML${FENCE}\\s*parameter\\s+name=["']([^"']+)["'][^>]*>([\\s\\S]*?)<\\/${FENCE}DSML${FENCE}\\s*parameter>`,
    "g"
  );
  const closeRe = new RegExp(`<\\/${FENCE}DSML${FENCE}\\s*invoke>`);

  let open;
  while ((open = openRe.exec(content)) !== null && calls.length < MAX_CALLS) {
    const name = cleanToolName(open[1]);
    if (!name) continue;

    const bodyStart = openRe.lastIndex;
    const closeIdx = content.slice(bodyStart).search(closeRe);
    const body = closeIdx === -1 ? content.slice(bodyStart) : content.slice(bodyStart, bodyStart + closeIdx);

    const args = {};
    let p;
    paramRe.lastIndex = 0;
    while ((p = paramRe.exec(body)) !== null) {
      args[p[1]] = coerceParamValue(stripResidualFences(p[2]));
    }

    calls.push({
      id: generateToolCallId(0, calls.length, name),
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
  }
  return calls;
}

/**
 * Parse the raw token-bar dialect.
 *
 * The end tags are not reliable: the model sometimes omits `<|tool▁call▁end|>`,
 * and captures show a call running straight into the next
 * `<|tool▁call▁begin|>` or into a hallucinated `<|tool▁output▁begin|>`. Each body
 * therefore terminates at whichever comes first: an end tag, the next call's
 * begin tag, the output marker, or end of string.
 *
 * @param {string} content
 * @returns {Array<{id:string,type:"function",function:{name:string,arguments:string}}>}
 */
function parseTokenBar(content) {
  const calls = [];
  const beginRe = new RegExp(`<\\|tool${TB}call${TB}begin\\|>`, "g");
  const sepRe = new RegExp(`<\\|tool${TB}sep\\|>`);
  const nextBeginRe = new RegExp(`<\\|tool${TB}call${TB}begin\\|>`);
  const terminators = [
    new RegExp(`<\\|tool${TB}call${TB}end\\|>`),
    new RegExp(`<\\|tool${TB}calls${TB}end\\|>`),
    new RegExp(`<\\|tool${TB}output${TB}begin\\|>`),
  ];

  let begin;
  while ((begin = beginRe.exec(content)) !== null && calls.length < MAX_CALLS) {
    const rest = content.slice(beginRe.lastIndex);

    let end = rest.length;
    const nextBegin = rest.search(nextBeginRe);
    if (nextBegin !== -1) end = Math.min(end, nextBegin);
    for (const t of terminators) {
      const idx = rest.search(t);
      if (idx !== -1) end = Math.min(end, idx);
    }

    const body = rest.slice(0, end);
    const sepIdx = body.search(sepRe);
    if (sepIdx === -1) continue;

    const name = cleanToolName(body.slice(0, sepIdx));
    const argsRaw = stripResidualFences(body.slice(sepIdx).replace(sepRe, ""));
    if (!name) continue;

    let args = argsRaw;
    try {
      args = JSON.stringify(JSON.parse(argsRaw));
    } catch {
      /* keep raw text; the client will surface the parse error */
    }

    calls.push({
      id: generateToolCallId(0, calls.length, name),
      type: "function",
      function: { name, arguments: args },
    });
  }
  return calls;
}

/**
 * Extract native DeepSeek tool calls from an assistant message whose `content`
 * leaked the raw markup.
 *
 * @param {{content?: string}} message
 * @returns {{message: object, hasTools: boolean}} `message` keeps any leading
 *   prose as `content` (or drops `content` entirely when the markup was the
 *   whole reply) and gains a normalized `tool_calls` array when markup matched.
 */
export function normalizeDeepseekToolCalls(message) {
  if (!message || typeof message !== "object") return { message, hasTools: false };
  const content = message.content;
  if (!hasDeepseekToolMarkup(content)) return { message, hasTools: false };

  let calls = parseDsml(content);
  if (calls.length === 0) calls = parseTokenBar(content);
  if (calls.length === 0) return { message, hasTools: false };

  // Leading prose stays as content; the markup itself must not reach the user.
  const cutPoints = [
    content.search(new RegExp(`<${FENCE}DSML${FENCE}`)),
    content.search(new RegExp(`<\\|tool${TB}calls?${TB}begin\\|>`)),
  ].filter((i) => i >= 0);
  const cut = cutPoints.length ? Math.min(...cutPoints) : 0;
  const prose = content.slice(0, cut).trim();

  const normalized = { ...message };
  if (prose) normalized.content = prose;
  else delete normalized.content;
  normalized.tool_calls = calls;

  return { message: normalized, hasTools: true };
}
