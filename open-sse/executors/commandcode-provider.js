import { DefaultExecutor } from "./default.js";

const MESSAGES_BASE_URL = "https://api.commandcode.ai/provider/v1/messages";

export class CommandCodeProviderExecutor extends DefaultExecutor {
  constructor() {
    super("commandcode-provider");
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    // Claude-only models live on /messages. When an OpenAI-shaped client asks for one,
    // chatCore sets targetFormat:"claude" but leaves runtimeTransport null (no transport
    // matched the client format), so the default would post Claude wire to /chat/completions.
    const isClaudeOnly = typeof model === "string" && model.startsWith("claude-");
    if (isClaudeOnly && !credentials?.runtimeTransport) return MESSAGES_BASE_URL;
    return super.buildUrl(model, stream, urlIndex, credentials);
  }
}
