// Command Code can send the finish chunk before its usage-only trailer. Keep
// them together so clients that stop at finish do not miss the real usage.
export function coalesceCommandCodeUsage() {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let pending = null;
  let timer = null;

  const emit = (controller, frame) => controller.enqueue(encoder.encode(`${frame}\n\n`));
  const flushPending = (controller) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    emit(controller, `data: ${JSON.stringify(pending)}`);
    pending = null;
  };

  const processFrame = (frame, controller) => {
    const lines = frame.split(/\r?\n/);
    const data = lines.filter(line => line.startsWith("data:"));
    const value = data.length === 1 ? data[0].slice(5).trim() : null;
    if (value === "[DONE]") {
      flushPending(controller);
      emit(controller, frame);
      return;
    }

    let event;
    try { event = value ? JSON.parse(value) : null; } catch { /* preserve malformed frames */ }
    if (event?.error) {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    } else if (event && pending && Array.isArray(event.choices) && event.choices.length === 0 && event.usage) {
      pending.usage = event.usage;
      flushPending(controller);
      return;
    } else if (event?.choices?.some(choice => choice?.finish_reason) && !event.usage) {
      flushPending(controller);
      pending = event;
      timer = setTimeout(() => {
        try { flushPending(controller); } catch { pending = null; }
      }, 3000);
      timer.unref?.();
      return;
    } else if (pending && event) {
      flushPending(controller);
    }
    emit(controller, frame);
  };

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || "";
      for (const frame of frames) if (frame) processFrame(frame, controller);
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) processFrame(buffer, controller);
      flushPending(controller);
    },
  });
}
