import { describe, expect, it } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { resolveStreamIntent } from "../../open-sse/handlers/chatCore/streamIntent.js";

// An absent `stream` flag used to mean "streaming", so JSON clients (OpenAI SDK
// calls without `stream`, Hermes, …) received a body labelled text/event-stream
// holding raw JSON plus a trailing `data: [DONE]`.
describe("resolveStreamIntent", () => {
  it("defaults to non-streaming when the client omits the flag", () => {
    expect(resolveStreamIntent({ body: {}, sourceFormat: FORMATS.OPENAI })).toBe(false);
    expect(resolveStreamIntent({ body: {}, sourceFormat: FORMATS.CLAUDE })).toBe(false);
  });

  it("honours an explicit flag over the format default", () => {
    expect(resolveStreamIntent({ body: { stream: true }, sourceFormat: FORMATS.OPENAI })).toBe(true);
    expect(resolveStreamIntent({ body: { stream: false }, sourceFormat: FORMATS.OPENAI })).toBe(false);
    // An always-stream format still lets an explicit `stream: true` through.
    expect(resolveStreamIntent({ body: { stream: true }, sourceFormat: FORMATS.GEMINI })).toBe(true);
  });

  it("keeps streaming-only formats streaming when the flag is absent", () => {
    expect(resolveStreamIntent({ body: {}, sourceFormat: FORMATS.GEMINI })).toBe(true);
    expect(resolveStreamIntent({ body: {}, sourceFormat: FORMATS.GEMINI_CLI })).toBe(true);
    expect(resolveStreamIntent({ body: {}, sourceFormat: FORMATS.ANTIGRAVITY })).toBe(true);
  });

  it("lets the Accept header decide when the flag is absent", () => {
    expect(resolveStreamIntent({ body: {}, sourceFormat: FORMATS.OPENAI, acceptHeader: "text/event-stream" })).toBe(true);
    expect(resolveStreamIntent({ body: {}, sourceFormat: FORMATS.OPENAI, acceptHeader: "application/json" })).toBe(false);
    // Both listed: ambiguous, so the format default wins.
    expect(resolveStreamIntent({ body: {}, sourceFormat: FORMATS.OPENAI, acceptHeader: "application/json, text/event-stream" })).toBe(false);
    // An explicit flag always beats the header.
    expect(resolveStreamIntent({ body: { stream: true }, sourceFormat: FORMATS.OPENAI, acceptHeader: "application/json" })).toBe(true);
  });

  it("streams upstream when the provider has no non-streaming endpoint", () => {
    expect(resolveStreamIntent({ body: { stream: false }, sourceFormat: FORMATS.OPENAI, providerRequiresStreaming: true })).toBe(true);
  });
});
