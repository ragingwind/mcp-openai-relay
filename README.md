# ai-relay

> An MCP relay that exposes OpenAI Chat Completions (and any OpenAI-compatible upstream) **or** Anthropic Messages as a Model Context Protocol tool.

> 한국어: [README.ko.md](./README.ko.md)

---

## Providers

| Provider | CLI / bin | SDK subpath | Notes |
|---|---|---|---|
| OpenAI Chat Completions | `ai-relay openai` (MCP) / `ai-relay openai chat-completions` (one-shot CLI) | [`ai-relay/openai`](./packages/ai-relay/README.md) | Compatible with any OpenAI-shaped upstream: OpenAI, Azure, vLLM, Ollama, OpenRouter, AI Gateway |
| Anthropic Messages | `ai-relay anthropic` (MCP) / `ai-relay anthropic messages` (one-shot CLI) | [`ai-relay/anthropic`](./packages/ai-relay/README.md#anthropic-messages) | `max_tokens` defaults to 1024; `temperature` range 0..1 |

> A deployed process MUST run a single provider at a time (ADR D8 in [`doc/ARCHITECTURE.md`](./doc/ARCHITECTURE.md)). Run two ai-relay processes side-by-side to expose both providers to one MCP host.

---

## Quick reference

**1. One-shot CLI** — run a model from the shell:

```bash
# OpenAI
AI_RELAY_API_KEY=sk-... npx ai-relay openai chat-completions -m gpt-4o-mini "ping"

# Anthropic
AI_RELAY_API_KEY=sk-ant-... npx ai-relay anthropic messages -m claude-sonnet-4-5 "ping"
```

(`-m` configures the model the CLI uses for this invocation; it is NOT sent in the MCP call arguments.)

**2. stdio MCP** — register in Claude Desktop / Claude Code / Cursor:

```json
{
  "mcpServers": {
    "ai-relay": {
      "command": "npx",
      "args": ["-y", "ai-relay", "openai", "-m", "gpt-4o-mini"],
      "env": { "AI_RELAY_API_KEY": "sk-..." }
    }
  }
}
```

The MCP host (Claude Desktop, Cursor, …) calls `tools/call` with `{ "messages": [...] }` only — model selection happens on the server (above, via `-m`; or via `AI_RELAY_MODEL` in the `env` block).

**3. Docker HTTP** — self-host an MCP HTTP endpoint:

```bash
docker run -p 8787:8787 \
  -e AI_RELAY_API_KEY=sk-... \
  -e AI_RELAY_AUTH_TOKEN=$(openssl rand -hex 32) \
  -e AI_RELAY_MODEL=gpt-4o-mini \
  ghcr.io/ragingwind/ai-relay:latest
```

`AI_RELAY_MODEL` is required — the Hono server rejects boot if it is unset.

**4. SDK** — embed in your own MCP server:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerOpenAIChat } from "ai-relay/openai";

const server = new McpServer({ name: "my-relay", version: "0.1.0" });
registerOpenAIChat(server, {
  apiKey: process.env.AI_RELAY_API_KEY!,
  model: "gpt-4o-mini",
});
await server.connect(new StdioServerTransport());
```

`model` is now a required field on `OpenAIChatConfig`; `registerOpenAIChat` throws at boot if it is missing.

---

## 1. One-shot CLI

Invocation: `ai-relay <provider> <tool> [flags] [input]`. Today `<provider>` is `openai` and `<tool>` is `chat-completions`. **Model and sampling parameters are server-side configuration** — set them via `-m`/`--model`/`--temperature`/`--max-tokens`/`--top-p`/`--stop` flags or the matching `AI_RELAY_*` env vars. Input is either a positional or piped via stdin (XOR); plain text becomes `{messages:[{role:"user",content:…}]}`, JSON literals (`{` / `[`) pass through but MUST only contain `messages` (extra keys are rejected by `.strict()`).

```bash
# Plain-text input (wrapped into {messages:[…]} automatically)
npx ai-relay openai chat-completions -m gpt-4o-mini "ping"

# JSON input (messages only — model lives in the flag/env, not the payload)
npx ai-relay openai chat-completions -m gpt-4o-mini \
  '{"messages":[{"role":"user","content":"ping"}]}'

# Stdin pipe + sampling override
echo "explain TLS in 2 sentences" \
  | npx ai-relay openai chat-completions -m gpt-4o-mini --temperature 0.2

# Azure OpenAI / vLLM / Ollama / AI Gateway — any OpenAI-compatible endpoint
npx ai-relay openai chat-completions -m gpt-4o-mini \
  --api-key sk-... --base-url https://my-azure.openai.azure.com/v1 "ping"
```

`npx ai-relay --help` for the full flag list. `-v` / `--verbose` (or `AI_RELAY_VERBOSE=1`) traces each stage to stderr; secrets are redacted, stdout JSON stays clean.

---

## 2. stdio MCP server

Register `ai-relay` as an MCP server in any host that spawns a child process and speaks JSON-RPC over stdin/stdout (Claude Desktop, Claude Code, Cursor, project-local `.mcp.json`). Provide both `AI_RELAY_API_KEY` and a model (via `-m` flag or `AI_RELAY_MODEL` env) and you're done — the MCP host then calls the tool with `{ "messages": [...] }` only.

Point at an OpenAI-compatible endpoint and pin sampling on the server side:

```json
{
  "mcpServers": {
    "ai-relay": {
      "command": "npx",
      "args": ["-y", "ai-relay", "openai"],
      "env": {
        "AI_RELAY_API_KEY": "sk-...",
        "AI_RELAY_MODEL": "gpt-4o-mini",
        "AI_RELAY_BASE_URL": "https://my-azure.openai.azure.com/v1",
        "AI_RELAY_TEMPERATURE": "0.7",
        "AI_RELAY_MAX_TOKENS": "4096"
      }
    }
  }
}
```

The bin also accepts `-m`/`--model`, `--api-key`, `--base-url`, `--max-tokens`, `--temperature`, `--top-p`, `--stop`, `--timeout`, `--env <path>` as flags. Either flags OR env vars work; `AI_RELAY_MODEL` (or `-m`) is required. Run `npx ai-relay --help` for the full list.

---

## 3. Docker HTTP server

The container serves MCP at `http://localhost:8787/api/mcp` (bearer-authenticated by `AI_RELAY_AUTH_TOKEN`) and a liveness probe at `http://localhost:8787/healthz`. The image is multi-arch (amd64 + arm64) on `ghcr.io/ragingwind/ai-relay:latest`.

For Docker Compose:

```bash
docker compose up                            # uses the published image
docker compose -f compose.dev.yml up --build # local build
```

For Vercel or another self-host of the Hono app, see [`examples/vercel/`](./examples/vercel/).

---

## 4. Embed the SDK

Above is the stdio variant. The same `registerOpenAIChat` works in HTTP (Hono / Node) and Cloudflare Workers. Runnable examples:

- [`examples/stdio/`](./examples/stdio/) — stdio MCP server
- [`examples/multi-upstream/`](./examples/multi-upstream/) — one server, multiple OpenAI-compatible upstreams
- [`examples/cloudflare-workers/`](./examples/cloudflare-workers/) — Workers
- [`examples/vercel/`](./examples/vercel/) — Vercel deploy of the Hono app
- [`examples/baseurl-recipes/`](./examples/baseurl-recipes/) — OpenAI-compatible upstream configuration recipes (xAI, DeepSeek, Mistral, Ollama, OpenRouter, vLLM, LM Studio, Vercel AI Gateway)

SDK API reference: [`packages/ai-relay/README.md`](./packages/ai-relay/README.md).

---

## 5. Verify with MCP Inspector

Spawn the stdio bin under [`@modelcontextprotocol/inspector --cli`](https://github.com/modelcontextprotocol/inspector) — no HTTP server, no host required:

```bash
AI_RELAY_API_KEY=sk-... \
  npx @modelcontextprotocol/inspector --cli npx ai-relay openai -m gpt-4o-mini --method tools/list
```

For non-default upstreams (Azure / vLLM / Ollama / AI Gateway / your-own-proxy), add `AI_RELAY_BASE_URL=https://your-endpoint.example.com/v1` before `npx`.

Full scenario matrix and evidence template: [`doc/QA-MCP-INSPECTOR.md`](./doc/QA-MCP-INSPECTOR.md) ([한국어](./doc/QA-MCP-INSPECTOR.ko.md)).

---

## Environment variables

| Variable | Required | Default |
|---|---|---|
| `AI_RELAY_API_KEY` | yes | — |
| `AI_RELAY_MODEL` | yes (HTTP app; stdio bin requires `-m` or this) | — |
| `AI_RELAY_BASE_URL` | no | OpenAI default |
| `AI_RELAY_TEMPERATURE` | no | upstream default |
| `AI_RELAY_MAX_TOKENS` | no | upstream default |
| `AI_RELAY_TOP_P` | no | upstream default |
| `AI_RELAY_STOP` | no (single value or comma-separated list) | — |
| `AI_RELAY_REQUEST_TIMEOUT_MS` | no | 60000 |
| `AI_RELAY_AUTH_TOKEN` | yes (Docker / HTTP app) | — |
| `AI_RELAY_PORT` | no (HTTP app) | 8787 |

---

## Documentation

- SDK API + recipes: [`packages/ai-relay/README.md`](./packages/ai-relay/README.md)
- Architecture: [`doc/ARCHITECTURE.md`](./doc/ARCHITECTURE.md) ([한국어](./doc/ARCHITECTURE.ko.md))
- Deployment runbook: [`doc/DEPLOY.md`](./doc/DEPLOY.md) ([한국어](./doc/DEPLOY.ko.md))
- MCP Inspector verification: [`doc/QA-MCP-INSPECTOR.md`](./doc/QA-MCP-INSPECTOR.md) ([한국어](./doc/QA-MCP-INSPECTOR.ko.md))

## License

MIT LICENSE
