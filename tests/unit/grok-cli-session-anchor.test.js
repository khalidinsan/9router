import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveGrokCliSessionId,
  poisonGrokCliSession,
  isGrokCliSessionPoisoned,
  _resetGrokCliTurnStore,
} from "../../open-sse/executors/grok-cli.js";
import { firstUserMessageSessionId } from "../../open-sse/utils/sessionManager.js";

describe("grok-cli session anchoring", () => {
  beforeEach(() => {
    _resetGrokCliTurnStore();
  });

  it("anchors session id on the first user message, not the connection", () => {
    const creds = { connectionId: "conn-1" };
    const bodyA = { model: "grok-4.6", messages: [{ role: "user", content: "hai" }] };
    const bodyB = { model: "grok-4.6", messages: [{ role: "user", content: "hai" }] };
    const bodyC = { model: "grok-4.6", messages: [{ role: "user", content: "different question" }] };
    const idA1 = resolveGrokCliSessionId(creds, bodyA);
    const idA2 = resolveGrokCliSessionId(creds, bodyB);
    const idC = resolveGrokCliSessionId(creds, bodyC);
    expect(idA1).toBe(idA2); // same conversation anchor
    expect(idC).not.toBe(idA1); // different first message → different conversation

    // no user message at all → one-shot, never a stable shared id
    const idEmpty1 = resolveGrokCliSessionId(creds, { model: "grok-4.6", messages: [{ role: "system", content: "sys" }] });
    const idEmpty2 = resolveGrokCliSessionId(creds, { model: "grok-4.6", messages: [{ role: "system", content: "sys" }] });
    expect(idEmpty1).not.toBe(idEmpty2);
  });

  it("first user content blocks (OpenAI text parts) anchor stably", () => {
    const creds = { connectionId: "conn-2" };
    const mk = (text) => ({
      model: "grok-4.6",
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    });
    const a = resolveGrokCliSessionId(creds, mk("hai"));
    const b = resolveGrokCliSessionId(creds, mk("hai"));
    const c = resolveGrokCliSessionId(creds, mk("halo"));
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it("poisoned conversations get a fresh id and never resolve back", () => {
    const creds = { connectionId: "conn-3" };
    const body = { model: "grok-4.6", messages: [{ role: "user", content: "can you compact" }] };
    const id = resolveGrokCliSessionId(creds, body);
    poisonGrokCliSession(id);
    expect(isGrokCliSessionPoisoned(id)).toBe(true);
    expect(resolveGrokCliSessionId(creds, body)).not.toBe(id);
    expect(resolveGrokCliSessionId(creds, body)).not.toBe(id);
  });

  it("poison is scoped to its own id only", () => {
    const creds = { connectionId: "conn-4" };
    const body = { model: "grok-4.6", messages: [{ role: "user", content: "hello" }] };
    const id = resolveGrokCliSessionId(creds, body);
    poisonGrokCliSession(id);
    const other = resolveGrokCliSessionId({
      connectionId: "conn-4",
    }, { model: "grok-4.6", messages: [{ role: "user", content: "other hello" }] });
    expect(other).not.toBe(id);
    expect(isGrokCliSessionPoisoned(other)).toBe(false);
  });

  it("firstUserMessageSessionId is stable and scoped by connection", () => {
    const a1 = firstUserMessageSessionId("grok-cli", "conn-5", { messages: [{ role: "user", content: "hai" }] });
    const a2 = firstUserMessageSessionId("grok-cli", "conn-5", { messages: [{ role: "user", content: "hai" }] });
    const b = firstUserMessageSessionId("grok-cli", "conn-6", { messages: [{ role: "user", content: "hai" }] });
    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
  });
});
