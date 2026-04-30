# mcp-openai-relay

A relay server that exposes the OpenAI Chat Completions API as an
[MCP (Model Context Protocol)](https://modelcontextprotocol.io) tool. Runs on
**Vercel** (serverless) or as a **Docker container** (self-hosted).

When you register this server with an MCP host such as Claude Code, the host's
LLM can call OpenAI models as if they were tools.

```
[ MCP host (Claude Code) ]  --bearer-->  [ this relay ]  --API key-->  [ OpenAI / compatible upstream ]
```

---

## Quick start (Docker Compose)

The fastest way to run the relay locally or on a single host:

```bash
git clone https://github.com/ragingwind/mcp-openai-relay.git
cd mcp-openai-relay
cp .env.example .env.local
#   Fill OPENAI_API_KEY and RELAY_AUTH_TOKEN (32+ bytes)
#   Token: openssl rand -hex 32
docker compose up -d
```

The MCP endpoint is now at `http://localhost:3939/api/mcp`. Connect from any
MCP host:

```bash
claude mcp add --transport http openai-relay \
  http://localhost:3939/api/mcp \
  --header "Authorization: Bearer <RELAY_AUTH_TOKEN value>"
```

Stop with `docker compose down`. The host port defaults to `3939` to avoid
clashing with the typical Next.js / Node `:3000`; override with `HOST_PORT=...
docker compose up -d`. For other deployment paths (raw `docker run`, Vercel
serverless), see [Deployment options](#deployment-options) below.

---

## Status

- **v1 (current)**: single tool `completion_chat`. Bearer token authentication. Streamable HTTP transport.
- v2 backlog: Responses API, OAuth 2.1, rate limiting, budget caps, observability — see [`doc/ARCHITECTURE.md` §11](./doc/ARCHITECTURE.md#11-future-work-v2-backlog).

---

## Deployment options

### Requirements
- An OpenAI (or OpenAI-compatible) API key
- A 32+ byte bearer token (`openssl rand -hex 32`)
- One of: **Docker** (recommended for self-host), **Node.js 20.x + pnpm 9** (for local dev), or a **Vercel Pro account** (for serverless)

### Local run (Node.js)

```bash
pnpm install
cp .env.example .env.local
# Fill in OPENAI_API_KEY and RELAY_AUTH_TOKEN in .env.local
#   token: openssl rand -hex 32
pnpm dev
```

The server listens at `http://localhost:3000/api/mcp`. `pnpm dev` refuses to
start (with actionable instructions) when `.env.local` is missing or the two
required values are not set.

### Verify the running server

Two scripts wrap the MCP smoke flow. Run either in a second terminal while
`pnpm dev` is running.

**`pnpm verify`** — automated three-scenario smoke test:

```bash
pnpm verify
```

Sends JSON-RPC directly to `/api/mcp` and reports PASS/FAIL for the three
client-assertable scenarios (C1 `tools/list`, C2 happy path, C5 wrong-bearer
401). Calls OpenAI once with `gpt-4o-mini` (~$0.0001 per run). Override with
`--url=` or `MCP_URL`.

**`pnpm inspect`** — ad-hoc single call (wraps `npx @modelcontextprotocol/inspector --cli`):

```bash
pnpm inspect                                                   # tools/call → completion_chat, "ping"
pnpm inspect --method=tools/list                               # list registered tools
pnpm inspect --message="안녕"                                  # custom user message
pnpm inspect --url=http://localhost:3001/api/mcp --model=gpt-4o
pnpm inspect --tool=other_tool --message="..."                 # different tool (when v2 adds more)
```

Flags fall back to `process.env` then `.env.local`: `MCP_URL`, `MCP_TOOL`,
`MCP_MODEL`, `MCP_MESSAGE`, `RELAY_AUTH_TOKEN`.

For the full five-scenario manual procedure (including C4 clamp and C6
cancellation), see [`doc/QA-MCP-INSPECTOR.md`](./doc/QA-MCP-INSPECTOR.md).

### Docker (self-hosted)

Compose (one command, recommended):

```bash
cp .env.example .env.local        # fill OPENAI_API_KEY + RELAY_AUTH_TOKEN
docker compose up -d
```

Or raw `docker run`:

```bash
docker build -t mcp-openai-relay .
docker run --rm -p 3939:3000 \
  -e OPENAI_API_KEY=sk-... -e RELAY_AUTH_TOKEN=$(openssl rand -hex 32) \
  mcp-openai-relay
```

Full container runbook (env contract, healthcheck, smoke, secrets check, compose lifecycle):
[`doc/DEPLOY.md` §5b](./doc/DEPLOY.md#5b-docker-self-hosted-container) and [§5c](./doc/DEPLOY.md#5c-docker-compose-single-command-launch).

### Vercel deployment

Quick path:

```bash
vercel link
vercel env add OPENAI_API_KEY    production --sensitive
vercel env add RELAY_AUTH_TOKEN  production --sensitive
vercel deploy --prod
```

After deployment the URL will be `https://<your-project>.vercel.app/api/mcp`.

> **Full runbook**: See [`doc/DEPLOY.md`](./doc/DEPLOY.md) for the complete procedure
> covering Production/Preview separation, OpenAI hard usage cap (v1's only cost defense),
> token rotation, first-deploy verification, and troubleshooting.

---

## Use from Claude Code

```bash
claude mcp add --transport http openai-relay \
  https://<your-project>.vercel.app/api/mcp \
  --header "Authorization: Bearer <RELAY_AUTH_TOKEN>"
```

Or register directly in `.mcp.json`:

```json
{
  "mcpServers": {
    "openai-relay": {
      "type": "http",
      "url": "${RELAY_URL:-https://<your-project>.vercel.app/api/mcp}",
      "headers": { "Authorization": "Bearer ${RELAY_AUTH_TOKEN}" }
    }
  }
}
```

> **Claude Desktop** registers remote MCP servers through **Settings → Connectors** in the UI (Pro/Max plans), not via `claude_desktop_config.json`.

---

## Tool specification

### `completion_chat`

Invokes OpenAI Chat Completions once and returns the accumulated response text.

| Input | Type | Required |
|---|---|---|
| `model` | `string` | ✅ |
| `messages` | `Array<{role, content}>` | ✅ |
| `temperature` | `number` (0~2) | |
| `max_tokens` | `number` (clamped to server ceiling) | |
| `top_p` | `number` (0~1) | |
| `stop` | `string \| string[]` | |

Response: accumulated text plus `usage` metadata. For the full schema see [`doc/ARCHITECTURE.md` §4](./doc/ARCHITECTURE.md#4-mcp-tool-definition).

---

## Environment variables

| Key | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | ✅ | Used to call OpenAI (Vercel Sensitive) |
| `RELAY_AUTH_TOKEN` | ✅ | Bearer token sent by the MCP host (32+ random bytes) |
| `OPENAI_BASE_URL` | | Override the OpenAI SDK base URL (Azure OpenAI / vLLM / Ollama / mock) |
| `MAX_OUTPUT_TOKENS_CEILING` | | Default `4096` |
| `REQUEST_TIMEOUT_MS` | | Default `60000` |

---

## Scripts

```bash
pnpm dev                 # next dev (port 3000) — preflights .env.local
pnpm dev:vercel          # vercel dev (verifies runtime parity)
pnpm build               # next build
pnpm typecheck           # tsc --noEmit
pnpm lint                # biome check .
pnpm test                # vitest run
pnpm test:unit           # unit tests only
pnpm test:integration    # integration tests only
pnpm verify              # smoke C1/C2/C5 against a running pnpm dev
pnpm inspect             # ad-hoc tools/call (wraps MCP Inspector CLI)
```

---

## Security notes

- Register `OPENAI_API_KEY` / `RELAY_AUTH_TOKEN` as Vercel **Sensitive** env vars (they cannot be re-read after creation).
- Use **separate OpenAI project keys** for Production and Preview, and configure a **hard usage cap** in the OpenAI dashboard for each project — this is v1's primary cost defense.
- Rotating `RELAY_AUTH_TOKEN`: generate a new token → update Vercel env → redeploy → update client headers.
- v1 has no rate limiting or budget counters. If a token leaks, the OpenAI cap is the only line of defense.

---

## Documentation

- **Architecture / design decisions / external references**: [`doc/ARCHITECTURE.md`](./doc/ARCHITECTURE.md)
- **AI agent collaboration guide**: [`CLAUDE.md`](./CLAUDE.md)

---

## License

MIT — see [LICENSE](./LICENSE).
