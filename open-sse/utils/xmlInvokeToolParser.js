import { generateToolCallId } from "../translator/concerns/toolCall.js";

const MAX_CALLS = 64;
const INVOKE_DETECT = /<invoke\s+name=["']/;

const TOOL_NAME = "[A-Za-z_][A-Za-z0-9_.:-]*";
const FUNCTION_CALLS_OPEN = "<function_calls>";
const FUNCTION_CALLS_CLOSE = "</function_calls>";
const GET_TOOL_NAME_OPEN = "<get_tool_name>";
const GET_TOOL_NAME_CLOSE = "</get_tool_name>";
const INVOKE_CLOSE = "</invoke>";
const PARAMETER_CLOSE = "</parameter>";

const CANDIDATE = /<function_calls>|<invoke\s+name=["']/g;
const INVOKE_OPEN_RE = new RegExp(`<invoke\\s+name=["'](${TOOL_NAME})["'][^>]*>`, "y");
const INVOKE_CLOSE_RE = /<\/invoke>/y;
const PARAM_OPEN_RE = new RegExp(`<parameter\\s+name=["']([^"']+)["'][^>]*>`, "y");
const WHITESPACE_RE = /\s*/y;

export function hasXmlInvokeToolMarkup(content) {
  return typeof content === "string" && content.length > 0 && INVOKE_DETECT.test(content);
}

function cleanToolName(name) {
  return name.trim().replace(/^functions\./, "");
}

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

/** Sticky match anchored exactly at `at`. */
function matchAt(re, text, at) {
  re.lastIndex = at;
  const match = re.exec(text);
  return match && match.index === at ? match : null;
}

function skipWhitespace(text, at) {
  WHITESPACE_RE.lastIndex = at;
  WHITESPACE_RE.exec(text);
  return WHITESPACE_RE.lastIndex;
}

/**
 * Parse one complete `<invoke name="…">…</invoke>` at `at`.
 *
 * Complete means every parameter is closed and the invoke itself is closed. A
 * truncated payload returns null: missing tags are never synthesized.
 *
 * @returns {{name: string, args: object, next: number}|null}
 */
function parseInvoke(text, at) {
  const open = matchAt(INVOKE_OPEN_RE, text, at);
  if (!open) return null;

  const name = cleanToolName(open[1]);
  const args = {};
  let pos = open.index + open[0].length;

  for (;;) {
    const next = skipWhitespace(text, pos);
    const parameter = matchAt(PARAM_OPEN_RE, text, next);
    if (!parameter) {
      pos = next;
      break;
    }
    const valueStart = parameter.index + parameter[0].length;
    const valueEnd = text.indexOf(PARAMETER_CLOSE, valueStart);
    if (valueEnd === -1) return null;
    // A close reached before the value ends means the tags interleave, so the
    // payload is not well formed.
    const invokeEnd = text.indexOf(INVOKE_CLOSE, valueStart);
    if (invokeEnd !== -1 && invokeEnd < valueEnd) return null;

    args[parameter[1]] = coerceParamValue(text.slice(valueStart, valueEnd));
    pos = valueEnd + PARAMETER_CLOSE.length;
  }

  if (Object.keys(args).length === 0) return null;
  const close = matchAt(INVOKE_CLOSE_RE, text, pos);
  if (!close) return null;

  return { name, args, next: pos + close[0].length };
}

/**
 * Parse a payload at `at`: one or more complete invokes, optionally wrapped in
 * a complete `<function_calls>` pair. Only whitespace may separate the tags, so
 * an explanation between them makes the payload unparseable rather than a call.
 *
 * @returns {{calls: Array<{name: string, args: object}>, end: number}|null}
 */
function parsePayload(text, at) {
  const wrapped = text.startsWith(FUNCTION_CALLS_OPEN, at);
  let pos = wrapped ? skipWhitespace(text, at + FUNCTION_CALLS_OPEN.length) : at;

  const calls = [];
  while (calls.length < MAX_CALLS) {
    const invoke = parseInvoke(text, pos);
    if (!invoke) break;
    calls.push(invoke);
    pos = skipWhitespace(text, invoke.next);
  }
  if (calls.length === 0) return null;

  if (wrapped) {
    if (!text.startsWith(FUNCTION_CALLS_CLOSE, pos)) return null;
    pos += FUNCTION_CALLS_CLOSE.length;
  }
  return { calls, end: pos };
}

/**
 * Widen the payload start over the dialect's own prefixes so they count as
 * markup rather than as text around it: a `<function_calls>` wrapper, or the
 * `<get_tool_name>NAME</get_tool_name>` line some Kiro streams emit ahead of
 * the invokes. Only whitespace may sit between them and the payload.
 */
function markupStartFor(text, at) {
  let start = at;
  for (;;) {
    let before = start;
    while (before > 0 && /\s/.test(text[before - 1])) before--;

    if (before >= FUNCTION_CALLS_OPEN.length
      && text.startsWith(FUNCTION_CALLS_OPEN, before - FUNCTION_CALLS_OPEN.length)) {
      start = before - FUNCTION_CALLS_OPEN.length;
      continue;
    }

    if (before >= GET_TOOL_NAME_CLOSE.length
      && text.startsWith(GET_TOOL_NAME_CLOSE, before - GET_TOOL_NAME_CLOSE.length)) {
      const nameOpen = text.lastIndexOf(GET_TOOL_NAME_OPEN, before - GET_TOOL_NAME_CLOSE.length - 1);
      if (nameOpen !== -1) {
        start = nameOpen;
        continue;
      }
    }
    return start;
  }
}

/**
 * Recover tool calls the model emitted as XML inside assistant `content`.
 *
 * Only a standalone payload is recovered: the message must consist of complete
 * `<invoke>` blocks with complete parameters, optionally wrapped by a complete
 * `<function_calls>` pair, and nothing else but whitespace. Anything else — a
 * fence, quotes, an explanation before or after, a damaged opener, a truncated
 * payload — is the model showing the syntax rather than calling a tool, so the
 * message is returned unchanged.
 *
 * @param {{content?: string}} message
 * @returns {{message: object, hasTools: boolean}}
 */
export function normalizeXmlInvokeToolCalls(message) {
  if (!message || typeof message.content !== "string" || !message.content) return { message, hasTools: false };
  // Structured calls already present are authoritative: never replace or
  // duplicate them with a recovered copy.
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return { message, hasTools: false };
  const content = message.content;

  CANDIDATE.lastIndex = 0;
  const candidate = CANDIDATE.exec(content);
  if (!candidate) return { message, hasTools: false };

  const payload = parsePayload(content, candidate.index);
  if (!payload) return { message, hasTools: false };

  // A call is the message's action, so it stands alone. Text on either side
  // makes the markup a demonstration.
  if (content.slice(0, markupStartFor(content, candidate.index)).trim()) return { message, hasTools: false };
  if (content.slice(payload.end).trim()) return { message, hasTools: false };

  const calls = payload.calls.map((call, index) => ({
    id: generateToolCallId(0, index, call.name),
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.args) },
  }));
  const normalized = { ...message, tool_calls: calls };
  delete normalized.content;
  return { message: normalized, hasTools: true };
}
