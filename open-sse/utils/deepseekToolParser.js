/**
 * Native DeepSeek tool-call markup parser.
 *
 * DeepSeek V4.1 Flash (and the V4 family generally) occasionally emits its
 * native token-based tool-call format as plain assistant `content` instead of
 * populating the structured OpenAI `tool_calls` array. The client then renders
 * the raw markup as text and never runs the tool.
 *
 * Two dialects ship from the same model family:
 *
 * 1. DSML — fenced with U+FF5C FULLWIDTH VERTICAL LINE (`｜`), one pipe per side
 *    via Token Harbor and two via WorkBuddy:
 *
 *      <｜DSML｜ calls>
 *      <｜DSML｜ invoke name="read">
 *      <｜DSML｜ parameter name="path" string="true">package.json:1-30</｜DSML｜ parameter>
 *      </｜DSML｜ invoke>
 *      </｜DSML｜ calls>
 *
 * 2. Token-bar — the raw special-token form, using U+2581 LOWER ONE EIGHTH
 *    BLOCK (`▁`) as the separator:
 *
 *      <|tool▁calls▁begin|><|tool▁call▁begin|>read<|tool▁sep|>{"path":"a.js"}<|tool▁call▁end|><|tool▁calls▁end|>
 *
 * Only a *standalone, complete* payload is recovered: intact openers (the `<` is
 * part of the markup, never guessed), every call and argument closed by its
 * matching end tag, and nothing but whitespace around the payload. Anything
 * else — prose around or between the tags, a fenced or inline sample, a
 * truncated capture, a damaged opener — keeps the original content byte for
 * byte. A model that talks about the dialect is explaining it, not calling a
 * tool, and a half-received call must never become an action.
 *
 * Both shapes normalize to the same OpenAI tool_calls item:
 *
 *   { id: string, type: "function", function: { name: string, arguments: string } }
 */

import { generateToolCallId } from "../translator/concerns/toolCall.js";

const MAX_CALLS = 64;

// U+FF5C FULLWIDTH VERTICAL LINE, the DSML fence.
const FW = "\uFF5C";
// U+2581 LOWER ONE EIGHTH BLOCK, the raw special-token separator.
const TB = "\u2581";

// One or two pipes per side, in the fullwidth spelling DeepSeek emits and the
// ASCII spelling some transports normalize it to. Longest first, so a double
// pipe is never read as a single one.
const FENCES = [`${FW}${FW}`, FW, "||", "|"];

// A tool name as the markup carries it: no whitespace, no tag characters.
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const NAME_ATTRIBUTE = /name\s*=\s*(["'])([^"']*)\1/;

// Token-bar markers, in the `▁` spelling DeepSeek emits and the `_` spelling
// some transports normalize to.
const TB_TOKEN = new RegExp(`<\\|tool[${TB}_](calls|call|sep|output)(?:[${TB}_](begin|end))?\\|>`, "g");

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

function skipSpace(text, at) {
  let pos = at;
  while (pos < text.length && /\s/.test(text[pos])) pos++;
  return pos;
}

/**
 * Match a complete DSML tag at `at` — `<fence DSML fence keyword attrs>`.
 *
 * The `<` is part of the markup and is never guessed, and the tag must close on
 * the same line of markup: an opener that runs into another `<` was truncated,
 * so what follows is prose rather than attributes.
 *
 * @returns {{fence: string, raw: string, end: number}|null} `raw` is the
 *   attribute text, `end` is just past the closing `>`.
 */
function openTag(text, at, keyword) {
  if (text[at] !== "<") return null;
  for (const fence of FENCES) {
    const head = `<${fence}DSML${fence}`;
    if (!text.startsWith(head, at)) continue;
    const keywordAt = skipSpace(text, at + head.length);
    if (!text.startsWith(keyword, keywordAt)) return null;
    const after = keywordAt + keyword.length;
    // The keyword must be the whole word: `calls_begin` is not `calls`.
    if (/[A-Za-z0-9_]/.test(text[after] ?? "")) return null;
    const close = text.indexOf(">", after);
    if (close === -1) return null;
    const raw = text.slice(after, close);
    if (raw.includes("<")) return null;
    return { fence, raw, end: close + 1 };
  }
  return null;
}

/**
 * Find the next `</fence DSML fence keyword>` at or after `from`.
 *
 * The close must repeat the opener's fence width: a call opened with two pipes
 * and closed with one is damaged markup, not a boundary.
 *
 * @returns {{index: number, end: number}|null}
 */
function findClose(text, from, fence, keyword) {
  const head = `</${fence}DSML${fence}`;
  for (let at = text.indexOf(head, from); at !== -1; at = text.indexOf(head, at + 1)) {
    const keywordAt = skipSpace(text, at + head.length);
    if (!text.startsWith(keyword, keywordAt)) continue;
    const end = skipSpace(text, keywordAt + keyword.length);
    if (text[end] === ">") return { index: at, end: end + 1 };
  }
  return null;
}

/**
 * Parse one complete `<fence DSML fence invoke name="…">…</… invoke>` at `at`.
 *
 * Complete means the invoke is closed and carries at least one closed
 * parameter. Missing tags are never synthesized.
 *
 * @returns {{name: string, args: object, next: number}|null}
 */
function parseDsmlInvoke(text, at) {
  const tag = openTag(text, at, "invoke");
  if (!tag) return null;
  const name = cleanToolName(NAME_ATTRIBUTE.exec(tag.raw)?.[2]);
  if (!TOOL_NAME.test(name)) return null;

  // The invoke's own close bounds every parameter. A parameter that would close
  // after it means the tags interleave, so the payload is not well formed.
  const invokeClose = findClose(text, tag.end, tag.fence, "invoke");
  if (!invokeClose) return null;

  const args = {};
  let pos = tag.end;
  for (;;) {
    const parameter = openTag(text, skipSpace(text, pos), "parameter");
    if (!parameter) break;
    const key = NAME_ATTRIBUTE.exec(parameter.raw)?.[2].trim();
    if (!key) return null;
    const valueClose = findClose(text, parameter.end, parameter.fence, "parameter");
    if (!valueClose || invokeClose.index < valueClose.index) return null;
    args[key] = coerceParamValue(text.slice(parameter.end, valueClose.index));
    pos = valueClose.end;
  }
  if (Object.keys(args).length === 0 || skipSpace(text, pos) !== invokeClose.index) return null;
  return { name, args, next: invokeClose.end };
}

/**
 * Parse a standalone DSML payload: one or more complete invokes, optionally
 * wrapped in a complete `calls` pair. Only whitespace may separate the tags and
 * nothing may follow the payload.
 *
 * @returns {Array<{name: string, args: object}>|null}
 */
function parseDsml(text) {
  const wrapper = openTag(text, 0, "calls");
  // The wrapper carries no attributes.
  if (wrapper?.raw.trim()) return null;
  let pos = wrapper ? wrapper.end : 0;

  const calls = [];
  while (calls.length < MAX_CALLS) {
    const invoke = parseDsmlInvoke(text, skipSpace(text, pos));
    if (!invoke) break;
    calls.push({ name: invoke.name, args: invoke.args });
    pos = invoke.next;
  }
  if (calls.length === 0) return null;

  if (wrapper) {
    const at = skipSpace(text, pos);
    const close = findClose(text, at, wrapper.fence, "calls");
    if (!close || close.index !== at) return null;
    pos = close.end;
  }
  // Standalone: a call is the message's action, so nothing but whitespace may
  // follow it. Trailing explanation means the model was showing the syntax.
  if (text.slice(pos).trim()) return null;
  return calls;
}

/**
 * The next token-bar marker at or after `from`. Scanning for a marker rather
 * than for `<` keeps a `<` inside a JSON argument from ending the payload early.
 *
 * @returns {{kind: string, index: number, end: number}|null}
 */
function nextToken(text, from) {
  TB_TOKEN.lastIndex = from;
  const match = TB_TOKEN.exec(text);
  if (!match) return null;
  return {
    kind: match[2] ? `${match[1]}_${match[2]}` : match[1],
    index: match.index,
    end: match.index + match[0].length,
  };
}

/** The marker starting exactly at `at`, if any. */
function tokenAt(text, at) {
  const token = nextToken(text, at);
  return token?.index === at ? token : null;
}

/**
 * Parse a standalone token-bar payload: complete `call_begin`/`sep`/`call_end`
 * groups, optionally wrapped in a complete `calls_begin`/`calls_end` pair, with
 * each argument body a complete JSON object.
 *
 * @returns {Array<{name: string, args: object}>|null}
 */
function parseTokenBar(text) {
  const head = tokenAt(text, 0);
  const wrapped = head?.kind === "calls_begin";
  let pos = wrapped ? head.end : 0;

  const calls = [];
  while (calls.length < MAX_CALLS) {
    const begin = tokenAt(text, pos);
    if (begin?.kind !== "call_begin") break;
    const separator = nextToken(text, begin.end);
    if (separator?.kind !== "sep") return null;
    const name = cleanToolName(text.slice(begin.end, separator.index));
    if (!TOOL_NAME.test(name)) return null;
    const end = nextToken(text, separator.end);
    if (end?.kind !== "call_end") return null;
    let args;
    try {
      args = JSON.parse(text.slice(separator.end, end.index).trim());
    } catch {
      return null;
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) return null;
    calls.push({ name, args });
    pos = end.end;
  }
  if (calls.length === 0) return null;

  if (wrapped) {
    const close = tokenAt(text, pos);
    if (close?.kind !== "calls_end") return null;
    pos = close.end;
  }
  if (text.slice(pos).trim()) return null;
  return calls;
}

/**
 * Extract native DeepSeek tool calls from an assistant message whose `content`
 * leaked the raw markup.
 *
 * Recovery requires a standalone, complete payload. Every other message — no
 * markup, prose around it, a fenced or quoted sample, a truncated capture — is
 * returned untouched with `hasTools:false`, so its text reaches the client
 * exactly as the model wrote it.
 *
 * @param {{content?: string, tool_calls?: Array}} message
 * @returns {{message: object, hasTools: boolean}} on success `message` loses
 *   `content` (the payload was the whole reply) and gains `tool_calls`.
 */
export function normalizeDeepseekToolCalls(message) {
  if (!message || typeof message !== "object") return { message, hasTools: false };
  const content = message.content;
  if (typeof content !== "string" || !content.trim()) return { message, hasTools: false };
  // Structured calls already present are authoritative: never replace or
  // duplicate them with a recovered copy.
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return { message, hasTools: false };

  const text = content.trim();
  const parsed = parseDsml(text) ?? parseTokenBar(text);
  if (!parsed) return { message, hasTools: false };

  const calls = parsed.map((call, index) => ({
    id: generateToolCallId(0, index, call.name),
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }));
  const normalized = { ...message, tool_calls: calls };
  delete normalized.content;
  return { message: normalized, hasTools: true };
}
