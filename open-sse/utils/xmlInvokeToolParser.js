/**
 * Native XML tool-call parser — `<function_calls><invoke name="…">`.
 *
 * Claude-family upstreams occasionally emit their tool calls as XML inside the
 * assistant `content` instead of populating the structured OpenAI `tool_calls`
 * array. Kiro does this on the `claude-opus-5.5*` ids: the client then renders
 * the markup as text and never runs the tool. Production capture
 * (2026-10-31, kiro / claude-opus-5.5-thinking):
 *
 *   <function_calls>
 *   <invoke name="read">
 *   <parameter name="i">Reading Pengajuan controller</parameter>
 *   <parameter name="path">…/Pengajuan.php:1-140</parameter>
 *   </invoke>
 *   …
 *   </function_calls>
 *
 * Two artefacts appear in the wild and are both tolerated here:
 *  - the `<function_calls>` wrapper is sometimes missing entirely, so an
 *    `<invoke>` block on its own is still recognized;
 *  - the model sometimes opens with a garbled `<get_tool_name>read</get_tool_name>`
 *    before the real block, which is treated as markup (never as prose).
 *
 * The parser is conservative and total: it requires at least one
 * `<parameter name="…">` inside an `<invoke>`, returns `hasTools:false` and the
 * untouched message when nothing matches, never throws on malformed input, and
 * caps extraction at MAX_CALLS. The last call may be unterminated (a truncated
 * stream), which still yields its complete parameters.
 */

import { generateToolCallId } from "../translator/concerns/toolCall.js";

const MAX_CALLS = 64;

// Precompiled, non-global: detection runs on every content delta.
const INVOKE_DETECT = /<invoke\s+name=["']/;
const PARAM_DETECT = /<parameter\s+name=["']/;
const INVOKE_OPEN = /<invoke\s+name=["']([^"']+)["'][^>]*>/g;
const PARAM_RE = /<parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/g;
const INVOKE_CLOSE = /<\/invoke>/;

// Everything that starts the markup block. Prose before the earliest of these
// is the model's actual answer; the rest must never reach the client.
const BLOCK_START = /<function_calls>|<get_tool_name>|<invoke\s+name=["']/;

/** True when `content` carries the XML tool-call dialect. */
export function hasXmlInvokeToolMarkup(content) {
  return typeof content === "string" && content.length > 0 && INVOKE_DETECT.test(content);
}

// A tool call whose opener lost its `<invoke name="` prefix still carries the
// name and its parameters. Production capture (kiro, claude-opus-5.5-thinking):
//
//   …tasklist.\n\n\nwrite">\n<parameter name="path">…</parameter>
//
// i.e. the last 13 characters of `<invoke name="` are gone and the rest was
// printed to the user. `oke name="task">` is the same loss seen from another
// turn. Recovering here only runs when no intact `<invoke name=` exists, so it
// cannot touch a well-formed call.
const MANGLED_OPENER = /(?:^|[\s>])(?:<inv)?(?:oke\s+)?(?:name=)?["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*>\s*(?=<parameter\s+name=["'])/;

/** Locate a mangled opener, returning the tool name and where it starts. */
function findMangledOpener(content) {
  const m = MANGLED_OPENER.exec(content);
  if (!m) return null;
  return { name: cleanToolName(m[1]), index: m.index + (m[0].length - m[0].trimStart().length) };
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
 * Extract XML tool calls from an assistant message whose `content` leaked the
 * markup.
 *
 * @param {{content?: string}} message
 * @returns {{message: object, hasTools: boolean}} `message` keeps any leading
 *   prose as `content` (or drops `content` entirely when the markup was the
 *   whole reply) and gains a normalized `tool_calls` array when markup matched.
 */
export function normalizeXmlInvokeToolCalls(message) {
  if (!message || typeof message !== "object") return { message, hasTools: false };
  const content = message.content;
  if (typeof content !== "string" || content.length === 0) return { message, hasTools: false };
  // An `<invoke>` without parameters is not a tool call — it is far more likely
  // to be sample markup the model was asked to write.
  if (!PARAM_DETECT.test(content)) return { message, hasTools: false };

  const intact = hasXmlInvokeToolMarkup(content);
  const mangled = intact ? null : findMangledOpener(content);
  if (!intact && !mangled) return { message, hasTools: false };

  const calls = [];
  if (intact) {
    INVOKE_OPEN.lastIndex = 0;
    let open;
    while ((open = INVOKE_OPEN.exec(content)) !== null && calls.length < MAX_CALLS) {
      const name = cleanToolName(open[1]);
      if (!name) continue;

      const bodyStart = INVOKE_OPEN.lastIndex;
      const closeIdx = content.slice(bodyStart).search(INVOKE_CLOSE);
      const body = closeIdx === -1 ? content.slice(bodyStart) : content.slice(bodyStart, bodyStart + closeIdx);

      const args = {};
      PARAM_RE.lastIndex = 0;
      let p;
      while ((p = PARAM_RE.exec(body)) !== null) {
        args[p[1]] = coerceParamValue(p[2]);
      }

      calls.push({
        id: generateToolCallId(0, calls.length, name),
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      });
    }
  }

  // Opener lost its `<invoke name="` prefix: the name and the parameter blocks
  // are still there, so the call is recoverable instead of being printed.
  if (calls.length === 0 && mangled) {
    const body = content.slice(mangled.index);
    const args = {};
    PARAM_RE.lastIndex = 0;
    let p;
    while ((p = PARAM_RE.exec(body)) !== null) {
      args[p[1]] = coerceParamValue(p[2]);
    }
    if (Object.keys(args).length > 0) {
      calls.push({
        id: generateToolCallId(0, 0, mangled.name),
        type: "function",
        function: { name: mangled.name, arguments: JSON.stringify(args) },
      });
    }
  }

  if (calls.length === 0) return { message, hasTools: false };

  // Leading prose stays as content; the markup itself must not reach the user.
  const start = intact ? content.search(BLOCK_START) : mangled.index;
  const prose = (start > 0 ? content.slice(0, start) : "").trim();

  const normalized = { ...message };
  if (prose) normalized.content = prose;
  else delete normalized.content;
  normalized.tool_calls = calls;

  return { message: normalized, hasTools: true };
}
