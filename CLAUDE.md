# CLAUDE.md — mcp-openai-relay

This file is the collaboration guide for every AI agent (builder/reviewer/tester/debugger, etc.)
working in this repository. **It overrides the global rules at `~/.claude/CLAUDE.md`.**

> **Required reading**: this repository's single source of truth (SSOT) is [`doc/ARCHITECTURE.md`](./doc/ARCHITECTURE.md).
> Design decisions, directory structure, environment variables, tool schemas, and the
> testing strategy all live there. This file only carries operational conventions
> (verify commands, conventions, prohibitions).

---

## 1. One-line summary

A relay server that exposes OpenAI Chat Completions as an MCP (Model Context Protocol) tool —
deployed on Vercel, Next.js App Router, Bearer authentication, single tool `openai_chat` in v1.

Full architecture: [`doc/ARCHITECTURE.md`](./doc/ARCHITECTURE.md)

---

## 2. Tech stack (summary)

- Next.js 15+ App Router, Node.js 20.x, Vercel Pro / region `iad1` / Fluid Compute
- `mcp-handler@^1.1` + `@modelcontextprotocol/sdk@^1.26` + `zod@^3` + `openai@^6`
- TypeScript strict (NodeNext ESM, `verbatimModuleSyntax: true`)
- pnpm `^9` (pinned via the `packageManager` field)
- Biome `^2` (lint + format)
- Vitest + MSW (testing)

Details: [`doc/ARCHITECTURE.md` §6](./doc/ARCHITECTURE.md#6-tech-stack-confirmed).

---

## 3. Verify Commands

> The `/dev` and `/qa` pipelines read this section to determine verification commands. Do not hardcode.

```yaml
build:    pnpm build         # next build (includes typecheck)
typecheck: pnpm typecheck    # tsc --noEmit
lint:     pnpm lint          # biome check .
test:     pnpm test          # vitest run
test:unit: pnpm test:unit    # vitest run tests/unit
test:integration: pnpm test:integration  # vitest run tests/integration
dev:      pnpm dev           # next dev (port 3000)
dev:vercel: pnpm dev:vercel  # vercel dev (for verifying Vercel runtime parity)
```

### Evidence policy
- `evidence-mode: none` — this project has no UI (API/MCP server only). Browser screenshot/video evidence gates auto-pass.
- Instead, the builder must record the following as evidence:
  - `tests/integration/route.test.ts` passing output
  - MCP Inspector manual invocation log (optional, `$STATE_DIR/manual-mcp-inspector.log`)

---

## 4. Coding conventions (repo-specific)

The following items extend or override the global `core.md`.

### Absolutely forbidden
- **Never log OpenAI/MCP response bodies via `console`/logs/error messages** — only metadata (model, token counts, latency, status) is allowed.
- Never expose `OPENAI_API_KEY` or `RELAY_AUTH_TOKEN` in plain text in code/tests/docs/commits.
- Never use `===` to compare bearer tokens — always use `timingSafeEqual` from `node:crypto`.
- Never bypass `MODEL_ALLOWLIST` validation when calling a model.
- Never add features outside v1 scope (Responses API, OAuth, rate limiting, external KV, observability — see [`doc/ARCHITECTURE.md` §11](./doc/ARCHITECTURE.md#11-future-work-v2-backlog)).
- Never bump only one of `mcp-handler`/`@modelcontextprotocol/sdk` — the two packages are ABI-coupled (`^1.1`, `^1.26`); upgrade them as a pair.

### Recommended
- All tool input zod schemas should use `.strict()`.
- Attach an `AbortController` to every OpenAI call — wire it to MCP `notifications/cancelled` or `request.signal`.
- Streaming calls must use `maxRetries: 0` (mid-stream retry causes duplicated output).
- Non-streaming calls may rely on the SDK default retry.
- Map errors to the stable `code` values in the [`doc/ARCHITECTURE.md` §3 — Error mapping](./doc/ARCHITECTURE.md#error-mapping) table.

---

## 5. Directory rules

```
app/api/[transport]/route.ts   ← MCP entry point, single route. No other routes are allowed (v1)
lib/                            ← tool, env, auth, OpenAI client modules
lib/tools/                      ← one MCP tool per file
tests/unit/                     ← MSW mocks only the OpenAI HTTP boundary; the SDK itself is real
tests/integration/              ← invokes the route handler directly with Web Request/Response
doc/                            ← ARCHITECTURE.md (SSOT) plus future diagrams/ADRs
```

Full tree: [`doc/ARCHITECTURE.md` §5](./doc/ARCHITECTURE.md#5-directory-structure).

---

## 6. Environment / secrets

| Key | Source |
|---|---|
| `OPENAI_API_KEY` | Vercel Sensitive env var (separate Production/Preview) |
| `RELAY_AUTH_TOKEN` | Vercel Sensitive env var (32+ random bytes) |
| `MODEL_ALLOWLIST` | Plain env var, default `gpt-4o-mini,gpt-4o,gpt-4.1-mini,gpt-4.1` |
| `MAX_OUTPUT_TOKENS_CEILING` | Plain, default `4096` |
| `REQUEST_TIMEOUT_MS` | Plain, default `60000` |

Local development uses `.env.local` (gitignored). `.env.example` records key names only.

Details: [`doc/ARCHITECTURE.md` §7](./doc/ARCHITECTURE.md#7-environment-variables).

---

## 7. Testing — what goes where

| Case | Location | Notes |
|---|---|---|
| Tool input zod validation | `tests/unit/openai-chat.test.ts` | Enumerate schema-violation cases |
| Model allowlist | `tests/unit/openai-chat.test.ts` | Both allow and reject |
| `max_tokens` clamp | `tests/unit/openai-chat.test.ts` | Caller value > ceiling case |
| OpenAI error mapping (401/429/400/5xx) | `tests/unit/openai-chat.test.ts` | Forge responses with MSW |
| Bearer auth (present/missing/invalid) | `tests/integration/route.test.ts` | Verify 401 + `WWW-Authenticate` header |
| `tools/list` JSON-RPC | `tests/integration/route.test.ts` | Confirm a single tool is exposed |
| `tools/call` happy path | `tests/integration/route.test.ts` | Mock OpenAI with MSW |
| Stream accumulation → single result | `tests/integration/route.test.ts` | MSW SSE response |
| MCP Inspector manual verification | Manual (not in CI) | Once before each PR — `pnpm dev` + `npx @modelcontextprotocol/inspector` |

Principle: **mock only the OpenAI HTTP boundary** (MSW). Never mock the `openai` module itself.

---

## 8. Commit / PR

- Conventional commits (per global `core.md`).
- The commit message body must start with an uppercase letter.
- Do not append "Generated with Claude Code" / "Co-Authored-By" footers (per the global rule).
- Use the [PR template](./.github/PULL_REQUEST_TEMPLATE.md) — it is auto-applied by GitHub on PR creation.
- The PR body must include:
  - Change summary (the why)
  - Output of `pnpm build && pnpm typecheck && pnpm lint && pnpm test`
  - **MCP Inspector verification result** — tick C1–C6 in the PR template per [`doc/QA-MCP-INSPECTOR.md`](./doc/QA-MCP-INSPECTOR.md). For docs-only / CI-config-only PRs, mark the section N/A with a one-line reason.
  - **v1 non-goal self-check** — tick the eight non-goal boxes in the PR template (auto-prevents scope creep into the v2 backlog).

---

## 9. Frequently forgotten items

- Set `runtime: nodejs20.x` explicitly in `vercel.json` — falling back to Edge hits the 25s TTFB cap.
- Export `export const maxDuration = 300` from the route file (do not depend on the dashboard default).
- If you do not wrap the route handler with `withMcpAuth`, authentication is not applied — verify this on every new route.
- Register `OPENAI_API_KEY` with **distinct OpenAI project keys** for Production and Preview, and set a **hard usage cap** in the OpenAI dashboard for each project (v1's cost defense).
- After `pnpm dev`, when connecting MCP Inspector you must enter the **Proxy Session Token** from the mcp-handler startup log.

---

## 10. Non-goals (v1)

The following are **deliberately excluded from v1**. Do not add them in PRs (the simplicity is intentional):

- Responses API tools
- Embeddings / image tools
- OAuth 2.1 authentication
- Rate limiting (Upstash, etc.)
- Daily token / dollar budget counters
- External observability (Sentry, OTel, Axiom, etc.)
- Progress notifications
- Tool/function-calling pass-through
- SSE transport / Redis

If a request comes in, register it in the [`doc/ARCHITECTURE.md` §11](./doc/ARCHITECTURE.md#11-future-work-v2-backlog) backlog and reject it from v1 scope.

---

## 11. References

- Architecture / design decisions / external sources: [`doc/ARCHITECTURE.md`](./doc/ARCHITECTURE.md) (especially the [Reference index](./doc/ARCHITECTURE.md#reference-index))
- Global rules: `~/.claude/CLAUDE.md`, `~/.claude/rules/*.md` (overridden by this file)
