# mcp-openai-relay

A relay server that exposes the OpenAI Chat Completions API as an
[MCP (Model Context Protocol)](https://modelcontextprotocol.io) tool.
Deployed as a **Vercel serverless function**.

When you register this server with an MCP host such as Claude Code, the host's
LLM can call OpenAI models as if they were tools.

```
[ MCP host (Claude Code) ]  --bearer-->  [ Vercel: this server ]  --API key-->  [ OpenAI ]
```

---

## Status

- **v1 (current)**: single tool `openai_chat`. Bearer token authentication. Streamable HTTP transport.
- v2 backlog: Responses API, OAuth 2.1, rate limiting, budget caps, observability — see [`doc/ARCHITECTURE.md` §11](./doc/ARCHITECTURE.md#11-future-work-v2-backlog).

---

## Quick start

### Requirements
- Node.js `20.x`
- pnpm `^9`
- An OpenAI API key
- (Deployment) A Vercel account (Pro recommended — function `maxDuration 300s`)

### Local run

```bash
pnpm install
cp .env.example .env.local
# Fill in OPENAI_API_KEY and RELAY_AUTH_TOKEN in .env.local
pnpm dev
```

The server listens at `http://localhost:3000/api/mcp`.

### Verify with MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

When the browser opens:
1. Transport: **Streamable HTTP**
2. URL: `http://localhost:3000/api/mcp`
3. Header: `Authorization: Bearer <RELAY_AUTH_TOKEN>`
4. Click **Connect** → in the Tools tab, invoke `openai_chat`

### Vercel deployment

```bash
vercel link
vercel env add OPENAI_API_KEY    # mark as Sensitive
vercel env add RELAY_AUTH_TOKEN  # mark as Sensitive
vercel deploy --prod
```

After deployment the URL will be `https://<your-project>.vercel.app/api/mcp`.

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

### `openai_chat`

Invokes OpenAI Chat Completions once and returns the accumulated response text.

| Input | Type | Required |
|---|---|---|
| `model` | `string` (allowlist) | ✅ |
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
| `MODEL_ALLOWLIST` | | CSV. Default `gpt-4o-mini,gpt-4o,gpt-4.1-mini,gpt-4.1` |
| `MAX_OUTPUT_TOKENS_CEILING` | | Default `4096` |
| `REQUEST_TIMEOUT_MS` | | Default `60000` |

---

## Scripts

```bash
pnpm dev                 # next dev (port 3000)
pnpm dev:vercel          # vercel dev (verifies runtime parity)
pnpm build               # next build
pnpm typecheck           # tsc --noEmit
pnpm lint                # biome check .
pnpm test                # vitest run
pnpm test:unit           # unit tests only
pnpm test:integration    # integration tests only
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

TBD
