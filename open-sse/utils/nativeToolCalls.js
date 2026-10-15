/**
 * Registry of native tool-call markup dialects.
 *
 * Several model families emit their native token-based tool-call format as
 * plain assistant `content` instead of populating the structured OpenAI
 * `tool_calls` array. Each family has its own dialect and its own parser:
 *
 *  - Kimi K2.x  → `functions.NAME:ID {json}`   (utils/kimiToolParser.js)
 *  - DeepSeek   → DSML `<｜DSML｜ invoke …>` and the raw `<|tool▁call▁begin|>`
 *                 token-bar form                (utils/deepseekToolParser.js)
 *
 * Both the streaming path (utils/stream.js) and the non-streaming path
 * (handlers/chatCore/nonStreamingHandler.js) need the same dispatch, so it
 * lives in this leaf module — importing it from stream.js would make
 * nonStreamingHandler depend on the stream module, which tests mock wholesale.
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
