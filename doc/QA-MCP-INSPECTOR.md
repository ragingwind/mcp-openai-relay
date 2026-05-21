# QA — MCP verification

> 한국어: [QA-MCP-INSPECTOR.ko.md](./QA-MCP-INSPECTOR.ko.md)

This is v1's **single verification procedure**. Run it once before every PR
merge AND once after every production deploy. It exists because v1 has no UI
(`evidence-mode: none` per `CLAUDE.md` §3) and therefore no automated browser
evidence; the MCP Inspector is the closest substitute for end-to-end
verification against a real OpenAI API call.

Two ways to run it:

- **Automated smoke** — `pnpm verify` covers C1, C2, C5 in ~10 seconds.
  Use this on most PRs.
- **Manual five-scenario** — required when C4 (server-side sampling override)
  or C6 (cancellation) is in scope, and after every production deploy.

> The caller-facing MCP tool input accepts only `{ messages }`. `model`,
> `temperature`, `max_tokens`, `top_p`, and `stop` are server-side
> configuration (env vars on the Hono app, flags on the stdio bin).
> Scenarios below assert `AI_RELAY_MODEL` / `AI_RELAY_MAX_TOKENS` on the server.

**Time budget**: ~3 minutes for the manual procedure once your env is set up.

> **For automated scenarios (Playwright, etc.) and periodic production health
> checks**, see [`ARCHITECTURE.md` §11](./ARCHITECTURE.md#11-future-work-v2-backlog) — both are v2 candidates.

---

## Automated smoke (`pnpm verify` / `pnpm inspect`)

Two scripts wrap the smoke flow against a running `pnpm dev`. Run either in a
second terminal.

### `pnpm verify` — automated three-scenario smoke

```bash
# terminal 1
pnpm dev

# terminal 2
pnpm verify
```

Sends JSON-RPC directly to `/api/mcp` and reports PASS/FAIL for **C1, C2, and
C5** — the three scenarios assertable from a client. Prints an evidence-record
block ready to paste into the PR. Costs ~$0.0001 per run (one `gpt-4o-mini`
call).

Inputs (env or flag — flag wins):

| env | flag | default | purpose |
|---|---|---|---|
| `MCP_URL` | `--url=<url>` | `http://localhost:8787/api/mcp` | endpoint (matches Hono `AI_RELAY_PORT` default) |

The model used for the C2 happy-path call is whatever `AI_RELAY_MODEL` is set
to on the running server (the caller schema is `{ messages }` only).

`AI_RELAY_AUTH_TOKEN` is read from `.env.local`.

C4 (server-side sampling override) and C6 (cancellation) cannot be asserted
from a client — for those two, fall through to the manual five-scenario
procedure below. Production-side re-verification (§E) is also manual: this
script is local-only.

### `pnpm inspect` — ad-hoc single call

Wraps `npx @modelcontextprotocol/inspector --cli` so a single tool call can be
made without the Inspector UI. Useful for iterating on prompts or pointing at a
non-default endpoint / model / tool.

```bash
pnpm inspect                                  # tools/call → chat-completions with "ping"
pnpm inspect --method=tools/list              # registered tools only
pnpm inspect --message="안녕"                 # custom user message
pnpm inspect --url=http://localhost:8788/api/mcp
pnpm inspect --tool=other_tool --message="..."
```

Flags (priority: `--flag=` > `process.env` > `.env.local` > default):

| Flag | env | default |
|---|---|---|
| `--url=`     | `MCP_URL`     | `http://localhost:8787/api/mcp` |
| `--token=`   | `AI_RELAY_AUTH_TOKEN` (also read from `.env.local`) | — |
| `--tool=`    | `MCP_TOOL`    | `chat-completions` |
| `--message=` | `MCP_MESSAGE` | `ping` |
| `--method=`  | —             | `tools/call` (also `tools/list`) |

`--model=` is not accepted — the model is server-side configuration
(`AI_RELAY_MODEL` env on the Hono server, `-m` flag on the stdio bin). The
tools/call arguments built by this script send `{ messages }` only.

---

## Manual procedure

`pnpm verify` covers only the client-assertable subset (C1, C2, C5). For
C4 (clamp), C6 (cancellation), and production re-verification, fall through
to the manual procedure below (sections A–E).

**Tip — verbose tracing.** When a scenario fails or you want to inspect the
parsed flags, env snapshot, OpenAI request, and JSON-RPC traffic, run the
bin with `-v` / `--verbose` (or set `AI_RELAY_VERBOSE=1`). The trace is
written to **stderr** so the stdout JSON-RPC channel that Inspector reads
remains clean.

```bash
ai-relay openai chat-completions -v -m gpt-4o-mini "ping"

AI_RELAY_VERBOSE=1 npx @modelcontextprotocol/inspector --cli \
  node packages/ai-relay/dist/bin/ai-relay.js openai -m gpt-4o-mini \
  --method tools/list
```

Secrets (`AI_RELAY_API_KEY`, `--api-key` value) appear only as
`***redacted(Nchars)***`. The full assistant response text is emitted in
the `openai-stream-end` event — treat the verbose stream as sensitive and
never persist it to shared logs, PR comments, or git.

## A. Preparation

1. Populate `.env.local` with **a personal dev OpenAI key** (not the production key),
   an `AI_RELAY_AUTH_TOKEN` of your choice (32+ bytes), and the upstream model:
   ```bash
   AI_RELAY_API_KEY=sk-...
   AI_RELAY_AUTH_TOKEN=$(openssl rand -hex 32)
   AI_RELAY_MODEL=gpt-4o-mini
   ```
   `.env.local` is gitignored — never commit values.

2. Start the dev server:
   ```bash
   pnpm dev
   ```
   The server listens on `http://localhost:8787` (Hono, matches
   `AI_RELAY_PORT` default). The MCP endpoint is
   `http://localhost:8787/api/mcp`.

3. **Warm-up**:
   ```bash
   curl -i "http://localhost:8787/api/mcp" \
     -H "Authorization: Bearer $AI_RELAY_AUTH_TOKEN" \
     -X GET
   ```
   Expect HTTP 4xx (mcp-handler responds to bare GET). Anything other than
   5xx proves the function reached.

---

## B. Inspector connection

1. In a separate terminal, start the Inspector:
   ```bash
   npx @modelcontextprotocol/inspector
   ```
   The Inspector prints a **Proxy Session Token** in stdout — keep this terminal
   visible.

2. The browser opens automatically. In the Inspector UI:
   - **Transport**: Streamable HTTP
   - **URL**: `http://localhost:8787/api/mcp`
   - **Header**: `Authorization: Bearer <AI_RELAY_AUTH_TOKEN>` (paste the
     value from your `.env.local`)
   - **Proxy Session Token**: paste the token from the Inspector terminal
     (`CLAUDE.md` §9 — frequently forgotten)

3. Click **Connect**. Expect the connection to succeed and the **Tools** tab
   to show one tool: `chat-completions`.

---

## C. Verification scenarios

All scenarios MUST pass before PR merge. C7 only applies when the relay
registers more than one upstream (the default v1 relay registers a single
`chat-completions` tool, so C7 is exercised in the SDK's
`multi-registration` example or in any consumer that registers multiple
upstreams on one server).

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| **C1** | Tool list | In Inspector, switch to **Tools** tab | Single tool `chat-completions` is listed. Its input schema is `{ messages: Array<{role, content}> }` only (no `model` / `temperature` / `max_tokens` / `top_p` / `stop` fields) — `.strict()`. |
| **C2** | Happy path | Click **Run Tool** on `chat-completions`. Inputs: `messages: [{role: "user", content: "ping"}]` (only field accepted). | Response contains accumulated text in `result.content[0].text`. `result.structuredContent.model` matches the server's `AI_RELAY_MODEL`. `result.structuredContent.usage.total_tokens > 0`. `result.isError` is `false`. |
| **C4** | Server-side sampling override | **Stop** the dev server. Restart with `AI_RELAY_MAX_TOKENS=64 AI_RELAY_TEMPERATURE=0.1 pnpm dev`. Re-run C2. | Response succeeds. Server stderr verbose log (`pnpm dev -v` or `AI_RELAY_VERBOSE=1`) shows `max_tokens: 64`, `temperature: 0.1` in the `openai-http-request` payload. Caller did not send these fields. |
| **C5** | Bearer rejection | In Inspector, **Disconnect**, change the Header to `Authorization: Bearer wrong-token`, **Connect** | Connection fails with HTTP 401 + `WWW-Authenticate: Bearer` header. Reconnect with the correct token to continue. |
| **C6** | Cancellation (manual) | Run C2 with a long prompt (e.g., "Write a 500-word essay about sourdough"). Mid-stream, **Disconnect** in the Inspector | Server logs show the SDK call aborted; OpenAI usage page (refreshed in ~1 minute) does NOT show full output cost. (Imprecise visual confirmation — manual observation only.) |
| **C7** | Multi-registration *(SDK consumers only)* | On a server that registered `registerOpenAIChat` against two distinct names (e.g. `chat-completions` + `azure_chat` with different `apiKey` + `baseURL` + `model`), open **Tools** then run each one with `{ messages: [...] }`. | `tools/list` returns both entries. Each `tools/call` answers from its own upstream with its own captured `model` (verify via `structuredContent.model` in each response). |

---

## D. Evidence record

After completing the procedure, record the result for the PR audit trail.
The convention is to write to `$STATE_DIR/manual-mcp-inspector.log` (or just
attach the equivalent text to the PR comment).

**Template**:

```
MCP Inspector verification — <YYYY-MM-DD HH:MM TZ>
Verifier:  <your name / handle>
Branch:    <branch name>
Commit:    <git rev-parse --short HEAD>
Endpoint:  http://localhost:8787/api/mcp  (or production URL — see doc/DEPLOY.md §3)
Model:     <AI_RELAY_MODEL value used by the server>

C1 tools/list (messages-only schema) — PASS / FAIL  <one-line note>
C2 chat-completions happy path       — PASS / FAIL  usage: {prompt_tokens: N, completion_tokens: N, total_tokens: N}
C4 server-side sampling override     — PASS / FAIL  <one-line note>
C5 wrong bearer 401                  — PASS / FAIL  <one-line note>
C6 cancellation                      — PASS / FAIL  <one-line note>

Notes:
- <any anomaly worth flagging>
```

If a scenario fails, redact secrets from any included response excerpt before
attaching to the PR (`AI_RELAY_API_KEY`, `AI_RELAY_AUTH_TOKEN`, full prompt text —
metadata only per `CLAUDE.md` §4).

---

## E. After production deploy

After running [`doc/DEPLOY.md` §3.4 verification checklist](./DEPLOY.md#34-verification-checklist),
re-run **C1, C2, C5** against the production URL
(`https://<project>.vercel.app/api/mcp`) using the **production**
`AI_RELAY_AUTH_TOKEN` and the prod-issued `AI_RELAY_API_KEY`.

C4 and C6 are local-only (the sampling override requires restarting the server
with different env vars; cancellation observation is harder to confirm in
production).

---

## F. Non-goals

- **Automated Inspector scenarios** (Playwright spawning the Inspector) — v2
  candidate; v1 keeps the manual loop because Inspector itself is a debugging
  UI, not a CI surface.
- **Periodic production health checks** (cron / monitoring) — v2 candidate
  (part of observability — see [`ARCHITECTURE.md` §11](./ARCHITECTURE.md#11-future-work-v2-backlog)).
- **Per-call usage assertions** — Inspector shows `usage` for each call but the
  procedure does not enforce specific token counts (model behavior varies).

---

## References

- [`ARCHITECTURE.md` §10](./ARCHITECTURE.md#10-testing-strategy-v1) — testing strategy (manual E2E layer)
- [`CLAUDE.md` §3](../CLAUDE.md#3-verify-commands) — evidence policy (`evidence-mode: none`)
- [`CLAUDE.md` §7](../CLAUDE.md#7-testing--what-goes-where) — test matrix (last row is this procedure)
- [`CLAUDE.md` §9](../CLAUDE.md#9-frequently-forgotten-items) — Proxy Session Token
- [`doc/DEPLOY.md` §3](./DEPLOY.md#3-docker-canonical) — Docker deployment (smoke flow uses `pnpm inspect`)
- [`doc/DEPLOY.md` §4](./DEPLOY.md#4-vercel-community-supported) — Vercel deployment (this procedure is referenced from §3.4)
