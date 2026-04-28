# QA — MCP Inspector manual E2E verification

This is v1's **single manual verification procedure**. Run it once before
every PR merge AND once after every production deploy. It exists because v1
has no UI (`evidence-mode: none` per `CLAUDE.md` §3) and therefore no
automated browser evidence; the MCP Inspector is the closest substitute for
end-to-end verification against a real OpenAI API call.

**Time budget**: ~3 minutes once you have the env set up.

> **For automated scenarios (Playwright, etc.) and periodic production health
> checks**, see [`ARCHITECTURE.md` §11](./ARCHITECTURE.md#11-future-work-v2-backlog) — both are v2 candidates.

---

## A. Preparation

1. Populate `.env.local` with **a personal dev OpenAI key** (not the production key)
   and a `RELAY_AUTH_TOKEN` of your choice (32+ bytes):
   ```bash
   OPENAI_API_KEY=sk-...
   RELAY_AUTH_TOKEN=$(openssl rand -hex 32)
   ```
   `.env.local` is gitignored — never commit values.

2. Start the dev server:
   ```bash
   pnpm dev
   ```
   The server listens on `http://localhost:3000`. The MCP endpoint is
   `http://localhost:3000/api/mcp`.

3. **Warm-up** (avoids the Inspector first-connect timing out on Next.js's
   initial JIT compile of the route):
   ```bash
   curl -i "http://localhost:3000/api/mcp" \
     -H "Authorization: Bearer $RELAY_AUTH_TOKEN" \
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
   - **URL**: `http://localhost:3000/api/mcp`
   - **Header**: `Authorization: Bearer <RELAY_AUTH_TOKEN>` (paste the
     value from your `.env.local`)
   - **Proxy Session Token**: paste the token from the Inspector terminal
     (`CLAUDE.md` §9 — frequently forgotten)

3. Click **Connect**. Expect the connection to succeed and the **Tools** tab
   to show one tool: `openai_chat`.

---

## C. Verification scenarios

All six MUST pass before PR merge.

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| **C1** | Tool list | In Inspector, switch to **Tools** tab | Single tool `openai_chat` is listed with input schema (model, messages, temperature, max_tokens, top_p, stop) |
| **C2** | Happy path | Click **Run Tool** on `openai_chat`. Inputs: `model: gpt-4o-mini`, `messages: [{role: "user", content: "ping"}]` | Response contains accumulated text in `result.content[0].text`. `result.structuredContent.usage.total_tokens > 0`. `result.isError` is `false`. |
| **C3** | Allowlist reject | Same as C2 but `model: gpt-9999` (a model definitely not in `MODEL_ALLOWLIST`) | Either zod validation rejects at parse time (error mentions `model not in allowlist`) OR `result.isError: true` with `code: "bad_request"`. The model is NOT called upstream. |
| **C4** | max_tokens clamp | Same as C2 but `max_tokens: 999999` (well above `MAX_OUTPUT_TOKENS_CEILING`) | Response succeeds; the value was silently clamped to `MAX_OUTPUT_TOKENS_CEILING` (default 4096) before the upstream call. No error. |
| **C5** | Bearer rejection | In Inspector, **Disconnect**, change the Header to `Authorization: Bearer wrong-token`, **Connect** | Connection fails with HTTP 401 + `WWW-Authenticate: Bearer` header. Reconnect with the correct token to continue. |
| **C6** | Cancellation (manual) | Run C2 with a long prompt (e.g., "Write a 500-word essay about sourdough"). Mid-stream, **Disconnect** in the Inspector | Server logs show the SDK call aborted; OpenAI usage page (refreshed in ~1 minute) does NOT show full output cost. (Imprecise visual confirmation — manual observation only.) |

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
Endpoint:  http://localhost:3000/api/mcp  (or production URL if §5 of doc/DEPLOY.md)

C1 tools/list                — PASS / FAIL  <one-line note>
C2 openai_chat happy path    — PASS / FAIL  usage: {prompt_tokens: N, completion_tokens: N, total_tokens: N}
C3 allowlist reject          — PASS / FAIL  <one-line note>
C4 max_tokens clamp          — PASS / FAIL  <one-line note>
C5 wrong bearer 401          — PASS / FAIL  <one-line note>
C6 cancellation              — PASS / FAIL  <one-line note>

Notes:
- <any anomaly worth flagging>
```

If a scenario fails, redact secrets from any included response excerpt before
attaching to the PR (`OPENAI_API_KEY`, `RELAY_AUTH_TOKEN`, full prompt text —
metadata only per `CLAUDE.md` §4).

---

## E. After production deploy

After running [`doc/DEPLOY.md` §5 first-deployment checklist](./DEPLOY.md#5-first-deployment),
re-run **C1, C2, C3, C5** against the production URL
(`https://<project>.vercel.app/api/mcp`) using the **production**
`RELAY_AUTH_TOKEN` and the prod-issued `OPENAI_API_KEY`.

C4 and C6 are local-only (the clamp behavior is the same on both environments;
cancellation observation is harder to confirm in production).

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
- [`README.md` §Verify with MCP Inspector](../README.md#verify-with-mcp-inspector) — the local quick-start version
- [`doc/DEPLOY.md` §5](./DEPLOY.md#5-first-deployment) — production-side application of this procedure
