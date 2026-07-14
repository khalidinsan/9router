#!/bin/bash
# Curl template to hit AgentRouter /v1/models with the full Claude CLI fingerprint
# used by this project (open-sse/providers/registry/agentrouter.js).
# Fill in YOUR_AGENTROUTER_TOKEN before running.

TOKEN="${YOUR_AGENTROUTER_TOKEN:?set YOUR_AGENTROUTER_TOKEN env var}"

curl -s https://agentrouter.org/v1/models \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-api-key: $TOKEN" \
  -H "Anthropic-Version: 2023-06-01" \
  -H "Anthropic-Beta: claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24,structured-outputs-2025-12-15,fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28,advisor-tool-2026-03-01,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07" \
  -H "Anthropic-Dangerous-Direct-Browser-Access: true" \
  -H "User-Agent: claude-cli/2.1.187 (external, cli)" \
  -H "X-App: cli" \
  -H "X-Stainless-Helper-Method: stream" \
  -H "X-Stainless-Retry-Count: 0" \
  -H "X-Stainless-Package-Version: 0.94.0" \
  -H "X-Stainless-Runtime: node" \
  -H "X-Stainless-Runtime-Version: v24.3.0" \
  -H "X-Stainless-Lang: js" \
  -H "X-Stainless-Arch: $(uname -m)" \
  -H "X-Stainless-Os: $(uname -s)" \
  -H "X-Stainless-Timeout: 600" | jq .
