/**
 * Split streamed assistant text that leaked Grok/Claude think wrappers
 * (`<thinking>…</thinking>` / `<think>…</think>`) into reasoning vs content.
 * Handles tags split across SSE deltas.
 */

const TAGS = [
  { name: "thinking", open: "<thinking>", close: "</thinking>" },
  { name: "think", open: "<think>", close: "</think>" },
];

const MAX_OPEN = Math.max(...TAGS.map((t) => t.open.length));
const MAX_CLOSE = Math.max(...TAGS.map((t) => t.close.length));

function couldBeTagPrefix(s) {
  if (!s) return false;
  const lower = s.toLowerCase();
  for (const tag of TAGS) {
    if (tag.open.startsWith(lower) || tag.close.startsWith(lower)) return true;
  }
  return lower === "<" || lower === "</";
}

function matchAt(haystack, index, needle) {
  return haystack.slice(index, index + needle.length).toLowerCase() === needle;
}

/**
 * @param {string} text
 * @param {{ mode?: string|null, carry?: string }} state
 * @returns {{ parts: Array<{ kind: "reasoning"|"content", text: string }>, state: { mode: string|null, carry: string } }}
 */
export function splitThinkTaggedText(text, state = {}) {
  const mode = state.mode || null;
  let carry = typeof state.carry === "string" ? state.carry : "";
  const src = carry + String(text ?? "");
  const parts = [];
  let i = 0;
  let currentMode = mode;

  const push = (kind, value) => {
    if (!value) return;
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += value;
    else parts.push({ kind, text: value });
  };

  while (i < src.length) {
    if (currentMode) {
      const tag = TAGS.find((t) => t.name === currentMode) || TAGS[0];
      const closeAt = (() => {
        const lower = src.toLowerCase();
        return lower.indexOf(tag.close, i);
      })();
      if (closeAt === -1) {
        const keep = Math.min(MAX_CLOSE - 1, src.length - i);
        const emitEnd = src.length - keep;
        if (emitEnd > i) push("reasoning", src.slice(i, emitEnd));
        return { parts, state: { mode: currentMode, carry: src.slice(emitEnd) } };
      }
      push("reasoning", src.slice(i, closeAt));
      i = closeAt + tag.close.length;
      currentMode = null;
      continue;
    }

    const lt = src.indexOf("<", i);
    if (lt === -1) {
      push("content", src.slice(i));
      return { parts, state: { mode: null, carry: "" } };
    }
    if (lt > i) push("content", src.slice(i, lt));

    const open = TAGS.find((t) => matchAt(src, lt, t.open));
    if (open) {
      i = lt + open.open.length;
      currentMode = open.name;
      continue;
    }
    const close = TAGS.find((t) => matchAt(src, lt, t.close));
    if (close) {
      // stray closer (the leaked `</thinking>` the user saw) — drop it
      i = lt + close.close.length;
      continue;
    }

    const tail = src.slice(lt);
    if (couldBeTagPrefix(tail.toLowerCase()) && lt + MAX_OPEN > src.length) {
      return { parts, state: { mode: null, carry: tail } };
    }
    push("content", src[lt]);
    i = lt + 1;
  }

  return { parts, state: { mode: currentMode, carry: "" } };
}

export function flushThinkTaggedState(state = {}) {
  const carry = typeof state.carry === "string" ? state.carry : "";
  if (!carry) return { parts: [], state: { mode: state.mode || null, carry: "" } };
  const kind = state.mode ? "reasoning" : "content";
  return { parts: [{ kind, text: carry }], state: { mode: null, carry: "" } };
}
