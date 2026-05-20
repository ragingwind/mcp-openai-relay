# CLAUDE.md — mcp-ai-relay

This file is the collaboration guide for every AI agent (builder/reviewer/tester/debugger, etc.)
working in this repository. **It overrides the global rules at `~/.claude/CLAUDE.md`.**

> **Required reading**: this repository's single source of truth (SSOT) is [`doc/ARCHITECTURE.md`](./doc/ARCHITECTURE.md).
> Design decisions, directory structure, environment variables, tool schemas, and the
> testing strategy all live there. This file only carries operational conventions
> (verify commands, conventions, prohibitions).

---

## 1. One-line summary

A relay server that exposes OpenAI Chat Completions as an MCP (Model Context Protocol) tool —
shipped as a Hono HTTP server packaged as a multi-arch Docker image
(`ghcr.io/ragingwind/ai-relay`), Bearer authentication, single tool `chat-completions` in v1.

Full architecture: [`doc/ARCHITECTURE.md`](./doc/ARCHITECTURE.md)

---

## 2. Tech stack (summary)

- Hono `^4` HTTP server + `@hono/node-server` adapter, Node.js 20.x, packaged as multi-arch container (amd64/arm64)
- `mcp-handler@^1.1` + `@modelcontextprotocol/sdk@^1.26` + `zod@^4` + `openai@^6`
- TypeScript strict (NodeNext ESM, `verbatimModuleSyntax: true`)
- pnpm `^9` (pinned via the `packageManager` field)
- Biome `^2` (lint + format)
- Vitest + MSW (testing)

Details: [`doc/ARCHITECTURE.md` §6](./doc/ARCHITECTURE.md#6-tech-stack-confirmed).

---

## 3. Verify Commands

> The `/dev` and `/qa` pipelines read this section to determine verification commands. Do not hardcode.

```yaml
build:    pnpm build         # pnpm -r build (SDK + app)
typecheck: pnpm typecheck    # tsc --noEmit across SDK + app
lint:     pnpm lint          # biome check .
test:     pnpm test          # vitest run
test:unit: pnpm test:unit    # vitest run packages/ai-relay/tests/unit
test:integration: pnpm test:integration  # vitest run --project integration
test:runtime: pnpm test:runtime  # pack tarball + run smoke fixtures (Node/Bun/CJS). Catches "consumer install without peer SDK" failures that vitest workspace-resolution masks.
dev:      pnpm dev           # Hono dev server (port 8787)
verify:   pnpm verify        # smoke against a running dev server
inspect:  pnpm inspect       # ad-hoc tools/call via MCP Inspector CLI (see doc/QA-MCP-INSPECTOR.md)
```

> **`test:runtime` rationale**: workspace-mode `pnpm test` resolves peer SDKs (`openai`, `@anthropic-ai/sdk`) via pnpm's symlinked `node_modules/.pnpm` tree, regardless of whether they are declared as required vs optional peers. The `runtime-matrix` smoke fixtures simulate a real `npm install <tarball>` install — only declared `dependencies` are present. Provider-SDK packaging regressions (missing peer dep, broken subpath import) surface here, not in `pnpm test`. Run before opening a PR that touches `peerDependencies` or `peerDependenciesMeta`.

### Evidence policy
- `evidence-mode: none` — this project has no UI (API/MCP server only). Browser screenshot/video evidence gates auto-pass.
- Instead, the builder must record the following as evidence:
  - `tests/integration/route.test.ts` passing output
  - MCP Inspector manual invocation log (optional, `$STATE_DIR/manual-mcp-inspector.log`)

---

## 4. Coding conventions (repo-specific)

The following items extend or override the global `core.md`.

### Absolutely forbidden
- **Never log OpenAI/MCP response bodies via `console`/logs/error messages at default/info levels** — only metadata (model, token counts, latency, status) is allowed at default output.
- **Exception — `--verbose` debug stream**: when explicitly enabled via `--verbose` flag or `AI_RELAY_VERBOSE=1`, the stderr trace MAY emit full request/response bodies (assistant text, tool arguments, OpenAI HTTP body). Secrets — API keys, bearer tokens, env values matching `*_KEY` / `*_TOKEN`, and the `Authorization` header value — MUST still be redacted via `redactSecret()`. Operators MUST treat the verbose stderr stream as sensitive: never persist it to shared logging infrastructure, never include it in PR comments or issue evidence, never check it into git.
- Never expose `AI_RELAY_API_KEY` or `AI_RELAY_AUTH_TOKEN` in plain text in code/tests/docs/commits.
- Never use `===` to compare bearer tokens — always use `timingSafeEqual` from `node:crypto`.
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
app/                                ← private pnpm workspace package (Hono server)
app/src/index.ts                    ← MCP entry point: GET /healthz + ALL /api/mcp (single route, v1)
app/src/env.ts                      ← AI_RELAY_* env validation (zod, redacted errors)
app/Dockerfile                      ← multi-stage container build (Node 20 alpine)
packages/ai-relay/src/              ← framework-agnostic SDK (ai-relay)
packages/ai-relay/src/<provider>/   ← provider-specific tools (today: openai/; future: anthropic/, gemini/, ai-gateway/)
packages/ai-relay/tests/unit/       ← SDK unit tests; MSW mocks only the OpenAI HTTP boundary; the SDK module itself is real
tests/integration/                  ← invokes the Hono `app.fetch(request)` adapter with Web Request/Response
examples/vercel/                    ← community-supported Vercel deploy recipe (vercel.json + README)
.github/workflows/release-app.yml   ← multi-arch buildx → ghcr push on `v*` tags
doc/                                ← ARCHITECTURE.md (SSOT) plus future diagrams/ADRs
```

Tool registration convention: each provider exports `register<Provider><Capability>(server, config)` (e.g. `registerOpenAIChat`). The default MCP tool name is overridable via `config.name` so a single server may register multiple instances of the same registrar against different upstreams.

Full tree: [`doc/ARCHITECTURE.md` §5](./doc/ARCHITECTURE.md#5-directory-structure).

---

## 6. Environment / secrets

> All `AI_RELAY_*` keys are interpreted per the invoking provider (see [ARCHITECTURE.md §12.1](./doc/ARCHITECTURE.md#121-env-interpretation-d8)). One process = one provider.

### Server (consumed by `app/src/env.ts`)

| Key | Required | Source / default |
|---|---|---|
| `AI_RELAY_API_KEY` | ✅ | Container env / orchestrator secret (separate Production/Preview keys) |
| `AI_RELAY_AUTH_TOKEN` | ✅ | Container env / orchestrator secret (32+ random bytes) |
| `AI_RELAY_MODEL` | ✅ | Upstream model id forwarded with every `tools/call`. The caller-facing tool input does not accept `model` — the server is the single source of truth. |
| `AI_RELAY_BASE_URL` | ❌ | Plain env var. Default: SDK built-in. Override to point at Azure OpenAI, vLLM/Ollama, or a mock. |
| `AI_RELAY_TEMPERATURE` | ❌ | Plain, 0..2. Forwarded with every upstream call when set. |
| `AI_RELAY_MAX_TOKENS` | ❌ | Plain, positive integer. Forwarded as `max_tokens` upstream. No server ceiling / clamp is applied. |
| `AI_RELAY_TOP_P` | ❌ | Plain, 0..1. Forwarded as `top_p` upstream when set. |
| `AI_RELAY_STOP` | ❌ | Plain. Single string or comma-separated list (`END` or `END,STOP`). Forwarded as `stop` upstream. |
| `AI_RELAY_REQUEST_TIMEOUT_MS` | ❌ | Plain, default `60000` |
| `AI_RELAY_PORT` | ❌ | Plain, default `8787`; valid range 1..65535 |

### CLI (consumed by the `ai-relay` bin in `packages/ai-relay/src/bin/`)

The bin reads the same `AI_RELAY_*` env keys as the server (model + sampling params). Flags always override env. See `ai-relay --help` for the full list.

| Key | Notes |
|---|---|
| `AI_RELAY_MODEL` | Required for `ai-relay <provider>` (MCP stdio launcher) and `ai-relay <provider> <tool>` (one-shot CLI mode — auto-dispatched when ≥2 positionals are supplied). Overridden by `-m` / `--model`. The MCP tool input does not accept a caller-supplied `model`. |
| `AI_RELAY_TEMPERATURE` / `AI_RELAY_MAX_TOKENS` / `AI_RELAY_TOP_P` / `AI_RELAY_STOP` | Forwarded to every upstream call when set. Overridden by `--temperature` / `--max-tokens` / `--top-p` / `--stop` flags. |

### Script-only (consumed by `scripts/mcp-inspect.mjs` and `scripts/verify.mjs`)

These are NOT read by the server. They only set defaults for the verification scripts; flags always win.

| Key | Used by | Default | Override |
|---|---|---|---|
| `MCP_URL`      | `verify`, `inspect` | `http://localhost:8787/api/mcp` | `--url=` |
| `MCP_TOOL`     | `inspect` | `chat-completions` | `--tool=` |
| `MCP_MESSAGE`  | `inspect` | `ping` | `--message=` |

> The MCP tool input is `{ messages }` only; the upstream model is read from
> the server-side `AI_RELAY_MODEL` and surfaced back via `structuredContent.model`.

Local development uses `.env.local` (gitignored). `.env.example` records key names only.

Details: [`doc/ARCHITECTURE.md` §7](./doc/ARCHITECTURE.md#7-environment-variables) (server) / [`doc/QA-MCP-INSPECTOR.md`](./doc/QA-MCP-INSPECTOR.md) (script).

---

## 7. Testing — what goes where

| Case | Location | Notes |
|---|---|---|
| Tool input zod validation | `packages/ai-relay/tests/unit/chat.test.ts` | Enumerate schema-violation cases |
| `max_tokens` clamp | `packages/ai-relay/tests/unit/chat.test.ts` | Caller value > ceiling case + injected ceiling override |
| OpenAI error mapping (401/429/400/5xx) | `packages/ai-relay/tests/unit/chat.test.ts` | Forge responses with MSW |
| `verifyBearer` constant-time comparison | `packages/ai-relay/tests/unit/auth.test.ts` | Length mismatch, single-byte change, NFC vs NFD |
| `parseEnv` validation + redaction | `packages/ai-relay/tests/unit/env.test.ts` | Failing-key path included; sentinel values never echoed |
| **Multi-registration** (same server, multiple upstreams) | `packages/ai-relay/tests/unit/multi-registration.test.ts` | Distinct names, no cross-talk, independent cancellation |
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

- Ensure `AI_RELAY_PORT` is set in production if the orchestrator binds to a non-default port — the Dockerfile defaults to 8787, but compose / k8s manifests should pass it explicitly to avoid surprises.
- Run `pnpm -F app build` before `docker build` if you have local changes — the Dockerfile compiles inside its builder stage but failing to mirror that locally first means CI cache misses.
- ghcr first-push setup: after the initial `release-app` run, the maintainer must (a) confirm Settings → Actions → Workflow permissions = "Read and write", and (b) Settings → Packages → ai-relay → Change visibility to public (default is private).
- If you do not wrap the `/api/mcp` handler with `withMcpAuth`, authentication is not applied — verify this when modifying `app/src/index.ts`.
- Register `AI_RELAY_API_KEY` with **distinct OpenAI project keys** for Production and Preview, and set a **hard usage cap** in the OpenAI dashboard for each project (v1's cost defense).
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
