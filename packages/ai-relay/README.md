# ai-relay

Provider-agnostic MCP relay SDK. Embed OpenAI Chat Completions (and any OpenAI-compatible upstream — Azure, vLLM, Ollama, AI Gateway) or Anthropic Messages as MCP tools.

## Install

```bash
# OpenAI provider
npm install ai-relay @modelcontextprotocol/sdk openai

# Anthropic provider
npm install ai-relay @modelcontextprotocol/sdk @anthropic-ai/sdk

# Both providers (one process per provider; D8)
npm install ai-relay @modelcontextprotocol/sdk openai @anthropic-ai/sdk
```

`@modelcontextprotocol/sdk` is required. `openai` and `@anthropic-ai/sdk` are **optional** peer dependencies — install only the SDK for the provider(s) you use. Requires **Node.js 20+** (or any runtime with `node:async_hooks` compatibility — Bun, Deno, Cloudflare Workers with `nodejs_compat`).

---

## Quick reference

**1. One-shot CLI** — `ai-relay <provider> <tool> [flags] [input]`:

```bash
# OpenAI
AI_RELAY_API_KEY=sk-... npx ai-relay openai chat-completions -m gpt-4o-mini "ping"

# Anthropic
AI_RELAY_API_KEY=sk-ant-... npx ai-relay anthropic messages -m claude-sonnet-4-5 "ping"
```

**2. stdio MCP server** — `ai-relay <provider>`, register in any MCP host:

```json
{
  "mcpServers": {
    "ai-relay-openai": {
      "command": "npx",
      "args": ["-y", "ai-relay", "openai", "-m", "gpt-4o-mini"],
      "env": { "AI_RELAY_API_KEY": "sk-..." }
    },
    "ai-relay-anthropic": {
      "command": "npx",
      "args": ["-y", "ai-relay", "anthropic", "-m", "claude-sonnet-4-5"],
      "env": { "AI_RELAY_API_KEY": "sk-ant-..." }
    }
  }
}
```

**3. SDK embed** — `registerOpenAIChat(server, config)`, `registerOpenAIResponses(server, config)`, or `registerAnthropicMessages(server, config)`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerOpenAIChat, registerOpenAIResponses } from "ai-relay/openai";

const server = new McpServer({ name: "my-relay", version: "0.1.0" });
registerOpenAIChat(server, {
  apiKey: process.env.AI_RELAY_API_KEY!,
  model: "gpt-4o-mini",
});
registerOpenAIResponses(server, {
  apiKey: process.env.AI_RELAY_API_KEY!,
  model: "gpt-5",
  reasoning_effort: "medium",
});
await server.connect(new StdioServerTransport());
```

### Chat vs Responses: when to use each

| | `chat-completions` (`./openai` → `registerOpenAIChat`) | `responses` (`./openai` → `registerOpenAIResponses`) |
|---|---|---|
| Endpoint | `/v1/chat/completions` | `/v1/responses` |
| Models | OpenAI Chat-compatible (`gpt-4o`, `gpt-4o-mini`, …) | OpenAI Responses-capable (`gpt-5`, `o3`, …) |
| Compatible upstreams | OpenAI, Azure OpenAI, vLLM, Ollama, OpenRouter, AI Gateway | OpenAI proper (and any upstream implementing `/v1/responses`) |
| Reasoning | not surfaced | optional `reasoning_effort: low | medium | high` → `reasoning.effort` |
| Result `structuredContent` | `model`, `usage`, `finish_reason` | adds `reasoning` (omitted when empty) |

Pick `responses` when targeting a reasoning model and you want to see the chain-of-thought summary; otherwise `chat-completions` is the most portable choice.

```ts
import { registerAnthropicMessages } from "ai-relay/anthropic";

registerAnthropicMessages(server, {
  apiKey: process.env.AI_RELAY_API_KEY!,
  model: "claude-sonnet-4-5",
  // max_tokens defaults to 1024 when omitted (Anthropic requires this field)
});
```

**4. Multi-upstream** — one server, multiple `registerOpenAIChat` calls with distinct `name` values (each call captures its own `model`):

```ts
registerOpenAIChat(server, {
  name: "chat-completions",
  apiKey: process.env.AI_RELAY_API_KEY!,
  model: "gpt-4o-mini",
});
registerOpenAIChat(server, {
  name: "azure-chat-completions",
  apiKey: process.env.AZURE_OPENAI_KEY!,
  baseURL: "https://<resource>.openai.azure.com/openai/deployments/<deployment>",
  model: "gpt-4o",
});
```

---

## 1. One-shot CLI (`ai-relay`)

Prints a single tool result as JSON on stdout, exits. Input is a positional argument or piped via stdin (XOR). A positional starting with `{` or `[` is parsed as JSON; anything else becomes a plain user message. Exit codes: `0` success, `1` runtime/upstream error, `2` usage error.

```bash
ai-relay openai chat-completions -m gpt-4o-mini "ping"
ai-relay openai chat-completions -m gpt-4o --temperature 0.2 \
  '{"messages":[{"role":"user","content":"ping"}]}'
ai-relay openai chat-completions -m gpt-4o-mini --base-url https://my-azure.openai.azure.com/v1 "ping"
echo '{"messages":[…]}' | ai-relay openai chat-completions -m gpt-4o-mini
```

**Model resolution** (first match wins): `-m`/`--model` flag → `AI_RELAY_MODEL` env. The caller schema is `{ messages }` only and `.strict()` rejects extra keys, so JSON input cannot include a `model` field.

| Flag | Purpose |
|---|---|
| `-m, --model <id>` | Model id (e.g. `gpt-4o-mini`) — required (flag or `AI_RELAY_MODEL`) |
| `--api-key <key>` | Override `AI_RELAY_API_KEY` |
| `--base-url <url>` | Override `AI_RELAY_BASE_URL` |
| `--max-tokens <n>` | Forwarded upstream as `max_tokens` (or `AI_RELAY_MAX_TOKENS`) |
| `--temperature <f>` | Sampling temperature 0..2 (or `AI_RELAY_TEMPERATURE`) |
| `--top-p <f>` | Nucleus sampling 0..1 (or `AI_RELAY_TOP_P`) |
| `--stop <csv>` | Stop sequence(s), comma-separated (or `AI_RELAY_STOP`) |
| `--timeout <ms>` | Per-request timeout |
| `--env <path>` | Load `AI_RELAY_*` from a dotenv file |
| `-v, --verbose` | Trace stages to stderr (also: `AI_RELAY_VERBOSE=1`) |

Verbose mode prints `argv`, `parsed-flags`, `loaded-config`, `openai-http-request`, `openai-stream-start`, `result`, etc. to stderr. Secrets are redacted; the full assistant response text is included in the `openai-stream-end` event — treat this stream as sensitive.

---

## 2. stdio MCP server (`ai-relay`)

Long-lived stdio MCP server. The `<provider>` positional (today: `openai`, `anthropic`) selects which upstream is mounted; all of that provider's tools are then registered. The `openai` provider mounts both `chat-completions` and `responses`; `anthropic` mounts `messages`.

Project-local `.mcp.json` with an absolute bin path:

```json
{
  "mcpServers": {
    "ai-relay": {
      "command": "node",
      "args": ["./node_modules/ai-relay/dist/bin/ai-relay.js", "openai", "-m", "gpt-4o-mini"],
      "env": { "AI_RELAY_API_KEY": "sk-..." }
    }
  }
}
```

`-m`/`--model` (or `AI_RELAY_MODEL` in `env`) is required. `--api-key`, `--base-url`, `--max-tokens`, `--temperature`, `--top-p`, `--stop`, `--timeout`, `--env` are accepted as flags too — pass them in `args` after the provider name.

For HTTP/SSE MCP transport instead of stdio, deploy the reference Hono app in this repo's [`app/`](https://github.com/ragingwind/mcp-ai-relay/tree/main/app) — see the project root README.

---

## 3. Embed via `registerOpenAIChat`

The quick reference above shows the stdio variant. Same function for Hono/HTTP and Cloudflare Workers.

### Hono / Node HTTP route

```ts
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig, verifyBearer } from "ai-relay";
import { registerOpenAIChat } from "ai-relay/openai";
import { createMcpHandler, withMcpAuth } from "mcp-handler";

const config = loadConfig({ env: process.env });
const provider = config.providers[0]!;

const handler = createMcpHandler(
  (server) => {
    registerOpenAIChat(server, {
      apiKey: provider.apiKey,
      model: provider.model,
      ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
      ...(provider.temperature !== undefined ? { temperature: provider.temperature } : {}),
      ...(provider.max_tokens !== undefined ? { max_tokens: provider.max_tokens } : {}),
      ...(provider.top_p !== undefined ? { top_p: provider.top_p } : {}),
      ...(provider.stop !== undefined ? { stop: provider.stop } : {}),
      ...(provider.requestTimeoutMs ? { requestTimeoutMs: provider.requestTimeoutMs } : {}),
    });
  },
  {},
  { basePath: "/api" },
);

const wrapped = withMcpAuth(
  handler,
  (_req, token) =>
    verifyBearer(token, process.env.AI_RELAY_AUTH_TOKEN!)
      ? { token: token as string, clientId: "shared-secret", scopes: ["openai:chat"] }
      : undefined,
  { required: true, requiredScopes: ["openai:chat"] },
);

const app = new Hono();
app.get("/healthz", (c) => c.text("ok", 200));
app.all("/api/mcp", (c) => wrapped(c.req.raw));

serve({ fetch: app.fetch, port: Number(process.env.AI_RELAY_PORT ?? 8787) });
```

### Cloudflare Workers

```ts
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOpenAIChat } from "ai-relay/openai";

export class OpenAIRelay extends McpAgent {
  server = new McpServer({ name: "openai-relay", version: "0.1.0" });

  async init() {
    registerOpenAIChat(this.server, {
      apiKey: this.env.AI_RELAY_API_KEY,
      model: this.env.AI_RELAY_MODEL,
    });
  }
}
```

`wrangler.toml` needs `compatibility_flags = ["nodejs_compat"]` so `AsyncLocalStorage` is available. Without it the SDK still works; upstream 5xx body snippets just won't appear in error result text.

---

## 4. Multi-upstream

`registerOpenAIChat` is closure-isolated — each call captures its own client, ceiling, and timeout. Call it any number of times with distinct `name` values to expose multiple upstreams as separate tools on one server.

```ts
const server = new McpServer({ name: "multi-relay", version: "0.1.0" });

registerOpenAIChat(server, {
  name: "chat-completions",
  apiKey: process.env.AI_RELAY_API_KEY!,
  model: "gpt-4o-mini",
});

registerOpenAIChat(server, {
  name: "azure-chat-completions",
  apiKey: process.env.AZURE_OPENAI_KEY!,
  baseURL: "https://<resource>.openai.azure.com/openai/deployments/<deployment>",
  model: "gpt-4o",
});

registerOpenAIChat(server, {
  name: "local-llm",
  apiKey: "not-needed",
  baseURL: "http://localhost:11434/v1",
  model: "llama3",
  max_tokens: 8192,
});
```

`tools/list` exposes `chat-completions`, `azure-chat-completions`, and `local-llm`. Each tool is invoked with `{ messages }` only; the upstream model and sampling parameters captured at `registerOpenAIChat` time are authoritative.

---

## API

```ts
import { registerOpenAIChat, makeOpenAIChatHandler, openAIChatTool } from "ai-relay/openai";
import { verifyBearer, loadConfig } from "ai-relay";
import { createOpenAIClient } from "ai-relay/openai";

interface OpenAIChatConfig {
  name?: string;
  description?: string;
  apiKey: string;
  baseURL?: string;
  model: string;                    // required — caller-facing input does not accept model
  temperature?: number;             // forwarded as-is to every upstream call
  max_tokens?: number;              // forwarded as-is; no server-side clamp
  top_p?: number;
  stop?: string | string[];
  requestTimeoutMs?: number;        // default 60000
  openaiClient?: OpenAI;            // inject your own client
  requestScope?: RequestScope;
}

registerOpenAIChat(server: McpServer, config: OpenAIChatConfig): void;
makeOpenAIChatHandler(config): { schema, handler, name, description };  // transport-agnostic
verifyBearer(actual: string, expected: string): boolean;                 // constant-time
loadConfig({ env?, file?, args? }): { providers: [...] };                // env/file/args resolution
createOpenAIClient(config): OpenAI;                                       // lower-level factory
```

## Result shape

```ts
{
  content: [{ type: "text", text: string }],
  structuredContent: {
    model: string,
    usage?: { prompt_tokens, completion_tokens, total_tokens },
    finish_reason?: "stop" | "length" | "tool_calls" | "content_filter" | "function_call",
    code?: "auth" | "rate_limited" | "context_length" | "content_policy" | "upstream_error" | "bad_request",
    retryAfter?: number,
  },
  isError: boolean,
}
```

## Anthropic Messages

The Anthropic provider mirrors the OpenAI provider shape: same caller schema (`{ messages }` only), same result shape (`content` + `structuredContent`), same registrar pattern. Differences are confined to upstream semantics:

- **`max_tokens` is required upstream** — defaults to 1024 when the config omits it.
- **`temperature` range is 0..1** (OpenAI accepts 0..2).
- **`system` messages** at the start of the `messages` array are extracted into Anthropic's top-level `system` field; non-leading `system` messages are rejected with `bad_request` (Anthropic has no interleaved-system representation).
- **`stop` → `stop_sequences`** — a single string is wrapped in an array; empty/whitespace entries are filtered.
- **`stop_reason` → `finish_reason`** mapping: `end_turn` → `stop`, `max_tokens` → `length`, `stop_sequence` → `stop`, `tool_use` → `tool_calls`, `refusal` → `content_filter` (also sets `isError: true` and `code: "content_policy"`).

### SDK embed

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAnthropicMessages } from "ai-relay/anthropic";

const server = new McpServer({ name: "anthropic-relay", version: "0.1.0" });
registerAnthropicMessages(server, {
  apiKey: process.env.AI_RELAY_API_KEY!,
  model: "claude-sonnet-4-5",
  max_tokens: 4096,
});
await server.connect(new StdioServerTransport());
```

`@anthropic-ai/sdk` is an **optional** peer dependency — install it explicitly when using this provider: `npm install @anthropic-ai/sdk`.

## Compatibility

| Dependency | Version |
|---|---|
| Node.js | 20+ |
| `@modelcontextprotocol/sdk` | `^1.26` |
| `openai` (optional) | `^6` |
| `@anthropic-ai/sdk` (optional) | `^0.96.0` |

ESM-only (`"type": "module"`). Only `node:` import is `node:async_hooks`.

## License

MIT.
