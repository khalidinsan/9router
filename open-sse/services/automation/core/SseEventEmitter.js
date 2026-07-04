export class SseEventEmitter {
  constructor(response) {
    this.response = response;
    this.response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
  }

  emit(event, data) {
    this.response.write(`event: ${event}\n`);
    this.response.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof this.response.flush === "function") this.response.flush();
  }

  log(level, step, message, meta = {}) {
    this.emit("log", { time: new Date().toISOString(), level, step, message, ...meta });
  }

  result(data) {
    this.emit("result", data);
  }

  done(summary) {
    this.emit("done", summary);
  }

  error(message) {
    this.emit("error", { message });
  }
}
