import { generateToolCallId } from "../translator/concerns/toolCall.js";

const MAX_CALLS = 64;
const INVOKE_DETECT = /<invoke\s+name=["']/;
const PARAM_RE = /<parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/g;
const BLOCK_START = /<function_calls>|<get_tool_name>|<invoke\s+name=["']/;

// Kiro captures lose varying prefixes of this header, including just `="read">`.
const HEADER = "<invoke name=";
const headerSuffixes = Array.from({ length: HEADER.length + 1 }, (_, offset) => HEADER.slice(offset));
const prefixPattern = headerSuffixes.map(prefix => prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
export const XML_INVOKE_OPENER_SOURCE = `(?:^|(?<=[\\s>]))(?:<invoke\\s+name=|${prefixPattern})["']?([A-Za-z_][A-Za-z0-9_.:-]*)["']?\\s*>\\s*(?=<parameter\\s+name=["'])`;
const INVOKE_OPEN = new RegExp(XML_INVOKE_OPENER_SOURCE, "g");

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

export function normalizeXmlInvokeToolCalls(message) {
  if (!message || typeof message.content !== "string" || !message.content) return { message, hasTools: false };
  const content = message.content;
  INVOKE_OPEN.lastIndex = 0;
  const calls = [];
  let firstStart = -1;
  let open;
  while ((open = INVOKE_OPEN.exec(content)) !== null && calls.length < MAX_CALLS) {
    const name = cleanToolName(open[1]);
    const bodyStart = INVOKE_OPEN.lastIndex;
    const closeAt = content.indexOf("</invoke>", bodyStart);
    const body = content.slice(bodyStart, closeAt === -1 ? content.length : closeAt);
    const args = {};
    PARAM_RE.lastIndex = 0;
    let parameter;
    while ((parameter = PARAM_RE.exec(body)) !== null) {
      args[parameter[1]] = coerceParamValue(parameter[2]);
    }
    if (Object.keys(args).length > 0) {
      if (firstStart === -1) firstStart = open.index;
      calls.push({
        id: generateToolCallId(0, calls.length, name),
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      });
    }
    // A tool payload may contain example invocations; never scan inside it.
    if (closeAt === -1) break;
    INVOKE_OPEN.lastIndex = closeAt + "</invoke>".length;
  }
  if (calls.length === 0) return { message, hasTools: false };

  const wrapperAt = content.search(BLOCK_START);
  const markupStart = wrapperAt === -1 ? firstStart : Math.min(wrapperAt, firstStart);
  const prose = content.slice(0, markupStart).trim();
  const normalized = { ...message, tool_calls: calls };
  if (prose) normalized.content = prose;
  else delete normalized.content;
  return { message: normalized, hasTools: true, markupStart };
}
