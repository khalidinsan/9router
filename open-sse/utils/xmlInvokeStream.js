/**
 * Incremental emitter for the XML tool-call dialect.
 *
 * `xmlInvokeToolParser` recovers a finished block, but holding the whole block
 * until it closes means a large payload — a `write` call carrying a 7 KB file —
 * produces no client-visible output for minutes, then lands in one burst. Live
 * measurement before this module: tool name and every argument chunk arrived at
 * 24052 ms, the final millisecond of the request.
 *
 * This emitter turns the same dialect into ordinary OpenAI streaming deltas as
 * the markup arrives: the call skeleton the moment `<invoke name="…">` closes,
 * then argument fragments per parameter, streamed inside a value so a long file
 * body is visible while it is still being written.
 *
 * Value typing matches `coerceParamValue` in the batch parser: a value opening
 * with `{`/`[`/digit/`-`/`true`/`false`/`null` is streamed raw, anything else is
 * streamed as a JSON string with escaping, so the concatenated arguments parse.
 *
 * The emitter is total: it never throws, and feeding the same text twice is the
 * caller's error (state advances). `push()` returns the deltas to attach to the
 * current chunk.
 */

const CLOSE_PARAM = "</parameter>";

function escapeJsonString(chunk) {
  return JSON.stringify(chunk).slice(1, -1);
}

/** Decide how a parameter value must be emitted from its first character. */
function valueMode(firstChar) {
  if (firstChar === "{" || firstChar === "[") return "raw";
  if (/[-0-9]/.test(firstChar)) return "raw";
  if (firstChar === "t" || firstChar === "f" || firstChar === "n") return "raw";
  return "string";
}

export function createXmlInvokeStreamEmitter() {
  let buf = "";
  let mode = "idle"; // idle | body | value
  let toolIndex = -1;
  let paramCount = 0;
  let anyParam = false;
  let valueStarted = false;
  let valueAsString = true;

  const deltas = [];

  function pushFragment(index, argsText) {
    if (!argsText) return;
    deltas.push({ index, function: { arguments: argsText } });
  }

  function closeValue() {
    if (!valueStarted) {
      // Parameter with an empty body: `"k":""`.
      pushFragment(toolIndex, valueAsString ? '""' : "null");
    } else if (valueAsString) {
      pushFragment(toolIndex, '"');
    }
    valueStarted = false;
  }

  function emitValue(chunk) {
    if (!chunk) return;
    if (!valueStarted) {
      const head = chunk.replace(/^\s+/, "");
      if (!head) return; // wait for a meaningful first character
      valueAsString = valueMode(head[0]) === "string";
      if (valueAsString) pushFragment(toolIndex, '"');
      valueStarted = true;
    }
    pushFragment(toolIndex, valueAsString ? escapeJsonString(chunk) : chunk);
  }

  function processTag(tag) {
    if (tag === "<function_calls>" || tag === "</function_calls>") return;

    const invoke = /^<invoke\s+name=["']([^"']+)["']/.exec(tag);
    if (invoke) {
      toolIndex += 1;
      paramCount = 0;
      anyParam = false;
      mode = "body";
      deltas.push({
        index: toolIndex,
        id: `call_${toolIndex}_${invoke[1].replace(/[^A-Za-z0-9_]/g, "")}`,
        type: "function",
        function: { name: invoke[1], arguments: "" },
      });
      return;
    }

    if (tag === "</invoke>") {
      if (!anyParam) pushFragment(toolIndex, "{}");
      else pushFragment(toolIndex, "}");
      mode = "idle";
      return;
    }

    const param = /^<parameter\s+name=["']([^"']+)["']/.exec(tag);
    if (param) {
      const key = param[1];
      pushFragment(toolIndex, `${paramCount === 0 ? "{" : ","}${JSON.stringify(key)}:`);
      paramCount += 1;
      anyParam = true;
      valueStarted = false;
      valueAsString = true;
      mode = "value";
    }
  }

  return {
    /**
     * Feed newly arrived markup text.
     *
     * @param {string} text
     * @returns {Array<object>} OpenAI tool_call deltas to emit on this chunk
     */
    push(text) {
      deltas.length = 0;
      if (typeof text !== "string" || !text) return deltas;
      buf += text;

      for (;;) {
        if (mode === "value") {
          const close = buf.indexOf(CLOSE_PARAM);
          if (close === -1) {
            // Keep a tail that could still be the start of the close tag.
            const keep = Math.min(buf.length, CLOSE_PARAM.length - 1);
            const safe = buf.slice(0, buf.length - keep);
            if (safe) {
              emitValue(safe);
              buf = buf.slice(buf.length - keep);
            }
            break;
          }
          emitValue(buf.slice(0, close));
          closeValue();
          buf = buf.slice(close + CLOSE_PARAM.length);
          mode = "body";
          continue;
        }

        const lt = buf.indexOf("<");
        if (lt === -1) {
          buf = "";
          break;
        }
        if (lt > 0) buf = buf.slice(lt);
        const gt = buf.indexOf(">");
        if (gt === -1) break; // incomplete tag — wait for the next delta
        const tag = buf.slice(0, gt + 1);
        buf = buf.slice(gt + 1);
        processTag(tag);
      }

      return deltas;
    },

    /** True once at least one call skeleton has been emitted. */
    get started() {
      return toolIndex >= 0;
    },

    /**
     * Close anything still open when the stream ends (a truncated payload),
     * so the concatenated arguments remain valid JSON.
     *
     * @returns {Array<object>} trailing deltas
     */
    finish() {
      deltas.length = 0;
      if (mode === "value") {
        // Release the tail the value scanner was still holding: at most a
        // partial close tag, which would otherwise be swallowed.
        let tail = buf;
        for (let n = CLOSE_PARAM.length - 1; n > 0; n -= 1) {
          if (tail.endsWith(CLOSE_PARAM.slice(0, n))) {
            tail = tail.slice(0, tail.length - n);
            break;
          }
        }
        if (tail) emitValue(tail);
        closeValue();
        buf = "";
      }
      if (mode !== "idle" && anyParam) pushFragment(toolIndex, "}");
      mode = "idle";
      return deltas;
    },
  };
}
