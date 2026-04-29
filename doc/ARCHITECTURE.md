# ARCHITECTURE — mcp-openai-relay

A relay server that exposes the OpenAI Chat Completions API as an MCP
(Model Context Protocol) tool. Deployed on Vercel: when an MCP host such as
Claude Code calls in, this server calls OpenAI and returns the response back
to the host.

This document is the single source of truth (SSOT) for v1 architecture.
For background research, tradeoffs, and alternatives considered, see the
sources in the [Reference index](#reference-index).

---

## 1. Core decisions (v1)

| # | Decision | Rationale (summary) |
|---|---|---|
| D1 | **Next.js 15+ App Router** with a single route | Matches Vercel's official `mcp-handler` template layout and OAuth metadata route examples |
| D2 | **OpenAI Chat Completions API only** (`/v1/chat/completions`) | Most ubiquitous and stable; Responses API, embeddings, and image tools belong to v2 |
| D3 | **Bearer shared-secret auth** (`withMcpAuth`) | Assumes single-user / small-scale use. OAuth 2.1 belongs to v2 |
| D4 | **Simple architecture** — no observability, rate limiting, or external KV | Observability comes later; rate limiting and budget caps belong to v2 |
| D5 | **Node.js 20.x + Fluid Compute, region `iad1`** | The official runtime for mcp-handler. Edge is excluded due to the 25s TTFB cap and compatibility issues |
| D6 | **Streamable HTTP transport only** (SSE disabled) | Stateless. Avoids Redis dependency |
| D7 | **OpenAI streams are accumulated server-side and returned as a single `CallToolResult`** | MCP `tools/call` returns a single result; there is no token-level streaming channel |

> **Note on D2**: "Completion" refers to the existing Chat Completions API, not OpenAI's newer Responses API.
> If the original intent was different, update D2 in this document.

---

## 2. System diagram

```
┌──────────────────────┐                ┌─────────────────────────────┐                 ┌───────────────────┐
│  MCP Host            │  Streamable    │  Vercel Function (Node 20)  │  HTTPS/SSE      │  OpenAI API       │
│  (Claude Code, etc.) │  HTTP + Bearer │  Next.js App Router         │  stream:true    │  /v1/chat/        │
│                      │ ─────────────► │  /api/[transport]/route.ts  │ ─────────────► │  completions      │
│                      │                │   ├─ withMcpAuth(bearer)    │                 │                   │
│                      │ ◄───────────── │   ├─ mcp-handler            │ ◄───────────── │                   │
│                      │  CallToolResult│   │   └─ tool: completion_chat │  delta chunks   │                   │
└──────────────────────┘                │   └─ accumulate stream      │                 └───────────────────┘
                                        │       → single text content │
                                        └─────────────────────────────┘
                                                     │
                                                     ▼
                                          OPENAI_API_KEY (Sensitive env var)
                                          RELAY_AUTH_TOKEN (Sensitive env var)
```

---

## 3. Request flow (happy path)

1. The MCP host sends `Authorization: Bearer <RELAY_AUTH_TOKEN>` plus a `tools/call` JSON-RPC message via `POST /api/mcp`.
2. `withMcpAuth` compares the header token to the `RELAY_AUTH_TOKEN` env var in constant time (timing-safe).
3. `mcp-handler` parses the JSON-RPC and invokes the `completion_chat` tool handler.
4. The tool handler validates input with zod → applies the server policy `max_tokens` ceiling → calls the `openai` SDK's `chat.completions.create({ stream: true, ... })` (with an `AbortController` attached).
5. The upstream stream is accumulated as an async iterator (`for await (const chunk of stream)`).
6. The accumulated text and `usage` metadata are serialized as a `CallToolResult`:
   ```ts
   {
     content: [{ type: "text", text: "<accumulated assistant message>" }],
     structuredContent: { model, usage: { prompt_tokens, completion_tokens, total_tokens } },
     isError: false
   }
   ```
7. The MCP host's client LLM merges the result into its context.

### Cancellation / disconnect
- On MCP `notifications/cancelled` → `AbortController.abort()` → the OpenAI request terminates (token billing stops).
- If the HTTP client disconnects, Next.js aborts `request.signal` → the same path propagates.

### Error mapping
| Upstream | Response |
|---|---|
| 401/403 (auth) | `isError: true`, `code: "auth"` |
| 429 (rate limit) | `isError: true`, `code: "rate_limited"`, `retryAfter` |
| 400 `context_length_exceeded` | `isError: true`, `code: "context_length"` |
| 400 content policy | `isError: true`, `code: "content_policy"` |
| 5xx / network | `isError: true`, `code: "upstream_error"` |
| Other 4xx | `isError: true`, `code: "bad_request"` |

The non-streaming path uses the SDK default retry (2 attempts). **The streaming path uses `maxRetries: 0`** (mid-stream retry causes duplicated output).

---

## 4. MCP tool definition

### `completion_chat`

Invokes OpenAI Chat Completions once and returns the accumulated text.

**Input schema (Zod)**

| Field | Type | Required | Notes |
|---|---|---|---|
| `model` | `string` | ✅ | Forwarded as-is to the upstream Chat Completions endpoint |
| `messages` | `Array<{role: "system"|"user"|"assistant", content: string}>` | ✅ | OpenAI Chat shape |
| `temperature` | `number` (0~2) | ❌ | OpenAI default applies |
| `max_tokens` | `number` (1~`MAX_OUTPUT_TOKENS_CEILING`, default 4096) | ❌ | Clamped to the server ceiling |
| `top_p` | `number` (0~1) | ❌ | |
| `stop` | `string | string[]` | ❌ | |

**Output schema**

```ts
{
  content: [{ type: "text", text: string }],
  structuredContent: {
    model: string,
    usage: { prompt_tokens: number, completion_tokens: number, total_tokens: number },
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call"
  }
}
```

**Notes**:
- `tool_choice` / `tools` parameters are not supported in v1 — tool calls are not forwarded.
- If a function/tool call appears in the response, it is not serialized to text; instead the tool surfaces `finish_reason: "tool_calls"` so the host LLM can decide what to do.

---

## 5. Directory structure

```
mcp-openai-relay/
├── app/
│   └── api/
│       └── [transport]/
│           └── route.ts          # mcp-handler entry point, withMcpAuth applied
├── lib/
│   ├── env.ts                    # env var loading + zod validation
│   ├── openai-client.ts          # openai SDK instance (singleton)
│   ├── auth.ts                   # bearer token verifyToken (timing-safe compare)
│   └── tools/
│       └── completion-chat.ts    # completion_chat tool handler + zod schema
├── doc/
│   └── ARCHITECTURE.md           # this document
├── tests/
│   ├── unit/
│   │   └── completion-chat.test.ts
│   └── integration/
│       └── route.test.ts         # invokes route directly via Web Request → Response
├── CLAUDE.md                     # agent collaboration guide
├── package.json
├── tsconfig.json
├── biome.json
├── vercel.json                   # pins maxDuration, region
├── .env.example
└── .gitignore
```

---

## 6. Tech stack (confirmed)

| Area | Choice |
|---|---|
| Framework | Next.js `^15` (App Router) |
| MCP handler | `mcp-handler@^1.1` |
| MCP SDK | `@modelcontextprotocol/sdk@^1.26` |
| Validation | `zod@^3` |
| OpenAI SDK | `openai@^6` |
| Runtime | Node.js `20.x` + Fluid Compute |
| Language | TypeScript strict, NodeNext ESM, `verbatimModuleSyntax: true` |
| Package manager | pnpm `^9` (pinned via `packageManager`) |
| Lint/Format | Biome `^2` |
| Test | vitest + msw (mock at the HTTP boundary) |
| Deployment | Vercel Pro, region `iad1`, `maxDuration: 300` |

### `vercel.json`
```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["iad1"],
  "functions": {
    "app/api/**/route.ts": {
      "maxDuration": 300,
      "runtime": "nodejs20.x"
    }
  }
}
```

### `tsconfig.json` essentials
```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noEmit": true
  }
}
```

---

## 7. Environment variables

| Key | Required | Secret | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | ✅ | Sensitive | OpenAI API key. Recommend separate keys for Production/Preview. |
| `OPENAI_BASE_URL` | ❌ | Plain | Override the OpenAI SDK base URL. Default: SDK built-in. Use to point at Azure OpenAI, a self-hosted vLLM/Ollama gateway, or a local mock. |
| `RELAY_AUTH_TOKEN` | ✅ | Sensitive | Bearer token sent by the MCP host. 32+ random bytes. |
| `MAX_OUTPUT_TOKENS_CEILING` | ❌ | Plain | Integer. Default `4096`. Overrides caller's value. |
| `REQUEST_TIMEOUT_MS` | ❌ | Plain | Integer. Default `60000`. OpenAI call timeout. |

Record keys only in `.env.example`; never commit values. Register the secrets in the Vercel dashboard with the Sensitive flag.

---

## 8. Authentication (v1)

```ts
// lib/auth.ts (concept)
import { timingSafeEqual } from "node:crypto";

export function verifyToken(req: Request, bearerToken: string | undefined) {
  if (!bearerToken) return undefined;            // unauthenticated
  const expected = process.env.RELAY_AUTH_TOKEN;
  if (!expected) return undefined;                // fail-closed
  const a = Buffer.from(bearerToken);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return undefined;
  if (!timingSafeEqual(a, b)) return undefined;
  return { clientId: "shared-secret", scopes: ["openai:chat"] };
}
```

Wrap the route handler with `withMcpAuth(handler, verifyToken, { required: true, requiredScopes: ["openai:chat"] })`.
On unauthenticated requests, `mcp-handler` automatically responds with 401 + `WWW-Authenticate` + the `/.well-known/oauth-protected-resource` headers.

> When graduating to OAuth 2.1 in v2, only `verifyToken` needs to change — the route signature stays the same.

---

## 9. Security — v1 minimum set

- Never echo `OPENAI_API_KEY` in responses, logs, or error messages.
- Always compare bearer tokens with `timingSafeEqual`.
- All tool inputs must be strictly validated with zod (use `.strict()`).
- `max_tokens` accepts the caller's value but is clamped to the server ceiling.
- `console` logs may include only metadata (model, token counts, latency, status). **Never log prompt/response bodies.**
- Preview deployments are protected by Vercel Authentication (default).

### Not included in v1 (intentional)
- Rate limiting (Upstash, etc.)
- Daily token/dollar budget counters
- OAuth 2.1
- External observability (Sentry, OTel, Axiom)
- Per-caller usage tracking

These items are listed as v2 candidates in §11.

---

## 10. Testing strategy (v1)

| Layer | Tools | Scope |
|---|---|---|
| Unit | vitest + msw | The `completion_chat` tool handler — input validation, max_tokens clamp, error mapping |
| Integration | vitest, route invoked directly via Web `Request`/`Response` | Bearer auth (present/missing/invalid), MCP `tools/list` and `tools/call` JSON-RPC flows |
| Manual E2E | MCP Inspector | Locally run `pnpm dev` → `npx @modelcontextprotocol/inspector` → Streamable HTTP, connect to `http://localhost:3000/api/mcp` |

Principle: **mock only the OpenAI HTTP boundary** (MSW). Never mock the SDK module itself — the risk of missing an SDK upgrade is too high.

---

## 11. Future work (v2+ backlog)

- **Responses API support** (add an `openai_responses` tool)
- **Embeddings / image** tools
- **OAuth 2.1** authentication (swap the `withMcpAuth` token verifier)
- **Rate limiting** — Upstash Ratelimit (Edge Middleware, IP + token two-tier)
- **Budget caps** — Upstash Redis daily token/dollar counters
- **Observability** — `@vercel/otel` traces + Pino NDJSON logs + (optional) Sentry
- **Progress notifications** — handle `_meta.progressToken` and emit progress messages
- **Tools/function-calling pass-through** — serialize `tool_calls` results into `structuredContent`

---

## Reference index

### MCP spec / SDK
- [MCP Specification 2025-11-25 (overview)](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Spec — Server: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP Spec — Basic: Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP Spec — Utility: Progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress)
- [MCP Spec — Utility: Cancellation](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation)
- [MCP Spec — Authorization (2025-06-18)](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [MCP Inspector docs](https://modelcontextprotocol.io/legacy/tools/inspector)
- [MCP Inspector repo](https://github.com/modelcontextprotocol/inspector)

### Vercel mcp-handler
- [npm: mcp-handler](https://www.npmjs.com/package/mcp-handler)
- [github.com/vercel/mcp-handler](https://github.com/vercel/mcp-handler)
- [Vercel docs — Deploy MCP servers to Vercel](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel)
- [Vercel blog — Building efficient MCP servers](https://vercel.com/blog/building-efficient-mcp-servers)
- [Vercel template — MCP with Next.js](https://vercel.com/templates/next.js/model-context-protocol-mcp-with-next-js)

### Vercel platform
- [Vercel — Functions Limits](https://vercel.com/docs/functions/limitations)
- [Vercel — Configuring Maximum Duration](https://vercel.com/docs/functions/configuring-functions/duration)
- [Vercel — Fluid compute](https://vercel.com/docs/fluid-compute)
- [Vercel — Runtimes](https://vercel.com/docs/functions/runtimes)
- [Vercel — Configuring regions](https://vercel.com/docs/functions/configuring-functions/region)
- [Vercel — Environment Variables](https://vercel.com/docs/environment-variables)
- [Vercel — Sensitive Environment Variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables)
- [Vercel — Bypass body size limit](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions)
- [Vercel — Package Managers](https://vercel.com/docs/package-managers)
- [Vercel KB — April 2026 Security Incident](https://vercel.com/kb/bulletin/vercel-april-2026-security-incident)
- [Vercel — Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)

### OpenAI
- [openai-node README](https://github.com/openai/openai-node)
- [openai npm metadata](https://registry.npmjs.org/openai/latest)
- [OpenAI — Migrate to Responses](https://platform.openai.com/docs/guides/migrate-to-responses)
- [OpenAI — API Deprecations](https://developers.openai.com/api/docs/deprecations)
- [OpenAI — Rate Limits Guide](https://developers.openai.com/api/docs/guides/rate-limits)

### Claude Code / Claude Desktop
- [Claude Code — MCP docs (`claude mcp add`, scopes, `.mcp.json`)](https://code.claude.com/docs/en/mcp)
- [Claude — Custom Integrations via Remote MCP (Connectors UI)](https://support.claude.com/en/articles/11175166-getting-started-with-custom-integrations-using-remote-mcp)

### Tools / libraries
- [Zod](https://zod.dev/)
- [Biome](https://biomejs.dev/)
- [Vitest](https://vitest.dev/)
- [MSW](https://mswjs.io/)
