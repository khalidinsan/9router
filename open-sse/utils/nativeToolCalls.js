import { normalizeKimiToolCalls } from "./kimiToolParser.js";
import { normalizeDeepseekToolCalls } from "./deepseekToolParser.js";
import { normalizeXmlInvokeToolCalls } from "./xmlInvokeToolParser.js";
import { extractToolNames } from "../translator/concerns/toolCall.js";

export function nativeToolCallParsersFor(model, body) {
  if (!Array.isArray(body?.tools) || body.tools.length === 0 ||
      body.tool_choice === "none" || body.tool_choice?.type === "none") return [];
  const parsers = [];
  if (/kimi-k2\./i.test(model || "")) parsers.push(normalizeKimiToolCalls);
  if (/deepseek/i.test(model || "")) parsers.push(normalizeDeepseekToolCalls);
  if (/claude|opus|sonnet|haiku/i.test(model || "")) parsers.push(normalizeXmlInvokeToolCalls);
  return parsers;
}

export function normalizeNativeToolCalls(model, message, body) {
  if (message?.tool_calls?.length) return null;
  for (const parse of nativeToolCallParsersFor(model, body)) {
    const result = parse(message);
    if (!result?.hasTools || result.message.content?.trim()) continue;
    const names = extractToolNames(body.tools);
    if (result.message.tool_calls.every(call => names.includes(call.function?.name))) return result;
  }
  return null;
}

const MARKER_OPENERS = [
  "<function_calls>", "<invoke",
  "<｜DSML｜", "<｜｜DSML｜｜", "<|DSML|", "<||DSML||",
  "<｜tool▁calls▁begin｜>", "<|tool▁calls▁begin|>",
  "functions.",
];
const MAX_OPEN_MARKER_LEN = 4 * 1024 * 1024;

// Only a standalone payload at the start of content can be a recovered call.
export function takeEmittableContent(pending) {
  const start = pending.trimStart();
  if (pending.length <= MAX_OPEN_MARKER_LEN &&
      MARKER_OPENERS.some(opener => opener.startsWith(start) || start.startsWith(opener))) {
    return { emit: "", hold: pending };
  }
  return { emit: pending, hold: "" };
}
