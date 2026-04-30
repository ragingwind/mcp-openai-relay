# DEPLOY — Vercel runbook for `mcp-openai-relay`

This runbook covers v1 deployment. The architecture decisions live in
[`ARCHITECTURE.md`](./ARCHITECTURE.md) (especially §6 `vercel.json`, §7 env vars,
§9 security). The collaboration / coding rules live in [`../CLAUDE.md`](../CLAUDE.md).

> **Cost defense**: v1 has no rate limiting or budget counters. The **OpenAI hard usage cap**
> (configured per project in the OpenAI dashboard) is the only line of defense if
> `RELAY_AUTH_TOKEN` leaks. **Set the cap before deploying.** See §3 below.

---

## 1. Prerequisites

- A Vercel account (Pro plan recommended — needed for `maxDuration: 300`).
- Two OpenAI projects (one for Production, one for Preview), each with its own API key
  and a hard usage cap configured in the OpenAI dashboard (see §3). The two-project split
  isolates a leaked Preview key from production billing.
- The Vercel CLI installed locally for the initial `vercel link`:
  ```bash
  npm i -g vercel    # or pnpm dlx vercel ...
  ```
- The repository cloned and dependencies installed (`pnpm install`).

---

## 2. Project setup (one-time)

### 2.1 Link the local checkout to a Vercel project

```bash
vercel link
```

Pick **Create new project** the first time, or select the existing project on subsequent
runs. `vercel link` writes `.vercel/project.json` — verify `.vercel/` is gitignored
(it is, per the `.gitignore` from #1).

### 2.2 Confirm runtime configuration

`vercel.json` already pins:

```json
{
  "regions": ["iad1"],
  "functions": {
    "app/api/**/route.ts": { "maxDuration": 300 }
  }
}
```

Node version is selected via `engines.node` in `package.json` (`>=20.0.0 <21.0.0`) —
Vercel's documented mechanism for Next.js. `app/api/[transport]/route.ts` also exports
`runtime = "nodejs"` and `maxDuration = 300` at the route level for defense in depth
(see `CLAUDE.md` §9 — frequently forgotten items).

After deploying, verify in the Vercel dashboard:
- **Settings → General → Node.js Version**: 20.x
- **Functions** tab: `app/api/[transport]/route.ts` listed as `nodejs20.x` with
  `Max Duration: 300s`
- **Settings → Functions → Region**: iad1 (Washington, D.C.)
- **Settings → Fluid Compute**: enabled (Pro plan default)

---

## 3. OpenAI hard usage cap (MANDATORY before first deploy)

For each OpenAI project key (one for Production, one for Preview):

1. Open the [OpenAI dashboard → Settings → Billing → Limits](https://platform.openai.com/account/limits).
2. Switch to the project (top-left selector).
3. Set **Hard limit** to a sensible monthly cap (e.g., `$10` for Preview, your tolerance for Production).
4. Set **Soft limit** lower (e.g., 50% of hard) for an early-warning email.

**This is the single cost defense in v1.** A leaked `RELAY_AUTH_TOKEN` with no rate limit on the relay can burn through OpenAI credit until the cap fires. See [`ARCHITECTURE.md` §11](./ARCHITECTURE.md#11-future-work-v2-backlog) for the v2 rate-limit plan.

---

## 4. Sensitive env-var registration

Register every key for **both** Production and Preview environments. Use the
**Sensitive** flag — Vercel will not let you re-read the value after creation
(audit-friendly; rotation is by replacement).

| Key | Required | Production value | Preview value | Sensitive |
|---|---|---|---|---|
| `OPENAI_API_KEY` | ✅ | upstream key #1 | upstream key #2 (different project / account) | ✅ |
| `RELAY_AUTH_TOKEN` | ✅ | 32+ random bytes (prod-only) | 32+ random bytes (preview-only) | ✅ |
| `OPENAI_BASE_URL` | ❌ | upstream base URL (omit for OpenAI default) | same or staging URL | — |
| `MAX_OUTPUT_TOKENS_CEILING` | ❌ | `4096` | `4096` | — |
| `REQUEST_TIMEOUT_MS` | ❌ | `60000` | `60000` | — |

### CLI commands

Generate a fresh `RELAY_AUTH_TOKEN`:

```bash
openssl rand -hex 32
```

Register Production secrets:

```bash
vercel env add OPENAI_API_KEY production --sensitive
vercel env add RELAY_AUTH_TOKEN production --sensitive
```

Register Preview secrets (use a *different* OpenAI key + a *different* relay token):

```bash
vercel env add OPENAI_API_KEY preview --sensitive
vercel env add RELAY_AUTH_TOKEN preview --sensitive
```

Register the optional plain env vars (only if you want to override defaults):

```bash
vercel env add OPENAI_BASE_URL production         # only if pointing at non-OpenAI upstream
vercel env add MAX_OUTPUT_TOKENS_CEILING production
vercel env add REQUEST_TIMEOUT_MS production
# ...repeat for preview
```

### Verify registration

```bash
vercel env ls
```

The Sensitive flag is shown as `Encrypted`. Values are not displayed — by design.

### Preview deployments are auto-locked

By default Vercel applies **Vercel Authentication** to Preview deployments — only
your team members can reach the preview URL. Verify in
**Settings → Deployment Protection**.

---

## 5. First deployment

```bash
vercel deploy --prod
```

Vercel returns the production URL: `https://<your-project>.vercel.app`.
The MCP endpoint is at `/api/mcp`.

### First-deployment verification checklist

- [ ] `vercel deploy --prod` completes without error.
- [ ] Vercel dashboard → **Functions** shows `app/api/[transport]/route.ts` listed
      as `nodejs20.x`, region `iad1`, `Max Duration: 300s`.
- [ ] Smoke test from terminal:
      ```bash
      curl -i https://<your-project>.vercel.app/api/mcp \
        -H "Authorization: Bearer $RELAY_AUTH_TOKEN" -X GET
      ```
      Expect HTTP 4xx (mcp-handler responds to bare GET) — anything other than 5xx
      proves the function reached. A 401 means the bearer is wrong; double-check.
- [ ] Run the [MCP Inspector verification flow](#mcp-inspector-against-the-prod-url)
      against the prod URL.
- [ ] OpenAI dashboard → **Usage** shows the call recorded against the prod
      project (proves the right key is wired).

### MCP Inspector against the prod URL

```bash
npx @modelcontextprotocol/inspector
```

In the Inspector UI:
1. **Transport**: Streamable HTTP
2. **URL**: `https://<your-project>.vercel.app/api/mcp`
3. **Header**: `Authorization: Bearer <RELAY_AUTH_TOKEN>`
4. Enter the **Proxy Session Token** from the Inspector's terminal output.
5. **Connect** → in the Tools tab call `completion_chat` with `gpt-4o-mini` and a
   short prompt; expect text + `usage` metadata.

(Issue #8 formalizes this checklist in `doc/QA-MCP-INSPECTOR.md`.)

---

## 5b. Docker (self-hosted container)

If you cannot or do not want to run on Vercel, the relay ships a multi-stage
`Dockerfile` at the repo root that produces a ~70 MB runtime image based on
`node:20-alpine` (digest-pinned for supply-chain stability), running as a
non-root user (UID 1001) with a Node `fetch` HEALTHCHECK against `/api/mcp`.

> **Pinned base image.** `Dockerfile` references `node:20-alpine@sha256:...`
> rather than the floating `node:20-alpine` tag. Floating tags can be silently
> repointed by upstream, breaking reproducibility. Bump the digest deliberately
> (`docker pull node:20-alpine && docker inspect node:20-alpine --format
> '{{.RepoDigests}}'`) — do not unpin.

> The container is the relay process only. Configure your reverse proxy / load
> balancer to allow long-running requests — there is no analogue of Vercel's
> 300 s function timeout, so the upstream timeout becomes the operator's
> responsibility. 300 s is a reasonable starting value if you want parity with
> the Vercel deployment.

### Build

```bash
docker build -t mcp-openai-relay .
```

Final image size should be under 200 MB. The build does not need real
secrets — the `pnpm build` script injects build-time dummy values.

### Run — inline `-e` flags

```bash
docker run --rm -p 8787:3000 \
  -e OPENAI_API_KEY=sk-... \
  -e RELAY_AUTH_TOKEN=$(openssl rand -hex 32) \
  -e OPENAI_BASE_URL=https://your-gateway.example.com/v1 \
  -e MAX_OUTPUT_TOKENS_CEILING=4096 \
  -e REQUEST_TIMEOUT_MS=60000 \
  mcp-openai-relay
```

The container listens on port `3000` internally; the host-side mapping
defaults to `8787` to avoid clashing with the typical Next.js / Node `:3000`.
Pick any free host port you prefer (`-p 9876:3000`, etc.).

`OPENAI_API_KEY` and `RELAY_AUTH_TOKEN` are required. `OPENAI_BASE_URL`,
`MAX_OUTPUT_TOKENS_CEILING`, and `REQUEST_TIMEOUT_MS` are optional (see
[`ARCHITECTURE.md` §7](./ARCHITECTURE.md#7-environment-variables) for defaults).

### Run — `--env-file`

Keep secrets in a file the operator manages (gitignored, locked-down perms):

```bash
docker run --rm -p 8787:3000 --env-file .env.production mcp-openai-relay
```

### HEALTHCHECK verification

```bash
docker inspect --format '{{.State.Health.Status}}' <container>
```

Expect `healthy` within ~30 s of start. The check sends `GET /api/mcp` and
treats any non-5xx response as healthy (mcp-handler returns 405 to a bare GET,
which proves the function reached).

### Smoke test

With the container running (default host port `8787`):

```bash
pnpm inspect --url=http://localhost:8787/api/mcp --method=tools/list
```

Expect a single tool named `completion_chat`. For the full pre-PR procedure
(C1–C6) see [`QA-MCP-INSPECTOR.md`](./QA-MCP-INSPECTOR.md).

### Verifying no secrets baked

```bash
docker history mcp-openai-relay --no-trunc | grep -iE 'OPENAI_API_KEY|RELAY_AUTH_TOKEN'
```

Only the `pnpm build` script's dummy values (`build-dummy`, 32×`x`) should
appear — never real credentials.

---

## 5c. Docker Compose (single-command launch)

For local development or single-host self-hosting, `compose.yml` at the repo
root wraps the same Dockerfile with a one-line lifecycle.

### One-shot

```bash
cp .env.example .env.local           # then fill OPENAI_API_KEY + RELAY_AUTH_TOKEN
docker compose up -d                  # builds on first run, then starts
```

The relay is reachable at `http://localhost:8787/api/mcp`. `restart:
unless-stopped` keeps it running across reboots.

### Host port override

The host-side port defaults to **`8787`** — the same default Cloudflare
Wrangler and Cloudflare's remote-MCP server examples use, so users in the
MCP ecosystem will recognise it. It also avoids the typical Next.js / Node
`:3000` collision. To map the relay to a different host port, set
`HOST_PORT`:

```bash
HOST_PORT=9876 docker compose up -d   # → http://localhost:9876/api/mcp
```

The container always listens on `3000` internally — only the host-side
mapping changes.

### Lifecycle

```bash
docker compose up -d                  # build + start (detached)
docker compose ps                     # status + health
docker compose logs -f relay          # follow logs
docker compose down                   # stop and remove the container
docker compose up -d --build          # rebuild after Dockerfile / source changes
```

### Smoke

```bash
pnpm inspect --url=http://localhost:8787/api/mcp --method=tools/list
```

### Env contract

`compose.yml` reads `.env.local` via `env_file:` and forwards every key into
the container's process env. The same env contract from §5b applies
(`OPENAI_API_KEY` + `RELAY_AUTH_TOKEN` required; `OPENAI_BASE_URL` /
`MAX_OUTPUT_TOKENS_CEILING` / `REQUEST_TIMEOUT_MS` optional).

> Compose does NOT replace the production runbook. For multi-host or managed
> orchestration use Kubernetes / a PaaS — `compose.yml` is for single-host
> self-hosting and local development.

---

## 6. Token rotation runbook (`RELAY_AUTH_TOKEN`)

Run when:
- A token is suspected leaked.
- A team member with token access leaves.
- Routine rotation (recommended every 90 days).

Steps:

1. Generate a new token:
   ```bash
   openssl rand -hex 32
   ```
2. Update the env var in Vercel (replace the existing value):
   ```bash
   vercel env rm RELAY_AUTH_TOKEN production
   vercel env add RELAY_AUTH_TOKEN production --sensitive
   # paste the new value when prompted
   ```
3. Redeploy so the new value is active:
   ```bash
   vercel deploy --prod
   ```
4. Update every MCP client (Claude Code, Claude Desktop Connectors, `.mcp.json` files)
   with the new bearer token.
5. Verify with `curl` or MCP Inspector that the new token works **and** the old one
   does not.
6. Audit OpenAI dashboard usage for any anomaly during the suspected-leak window.

> **Repeat the entire procedure for Preview** if the Preview token is the one being
> rotated. Production and Preview have independent tokens — rotating one does not
> affect the other.

---

## 7. Rotating `OPENAI_API_KEY`

Vercel side is identical to §6 (`vercel env rm` → `vercel env add` → `vercel deploy --prod`).
Additionally:

1. **Revoke the old key** in the OpenAI dashboard (otherwise it remains valid).
2. **Confirm the hard usage cap** is still set on the new key (caps are per-key).
3. Re-run the first-deploy verification checklist (§5).

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `pnpm build` fails locally with `Invalid environment: ...` | Module-level `parseEnv(process.env)` evaluation; missing env at build time | The `package.json` `build` script injects dummy values for `OPENAI_API_KEY` and `RELAY_AUTH_TOKEN`. If you stripped that, restore it or set real env in `.env.local`. |
| Vercel build fails with the same env error | Same as above, in CI/Vercel | Vercel injects real env vars at build time when you've registered them — verify with `vercel env ls`. |
| `curl` returns 401 + `WWW-Authenticate: Bearer` | Bearer token absent or wrong | Compare your client header to the value of `RELAY_AUTH_TOKEN` in Vercel. |
| `tools/call` returns `isError: true, code: "auth"` | Wrong `OPENAI_API_KEY` | Verify the key in the OpenAI dashboard. |
| `tools/call` returns `code: "rate_limited"` with `retryAfter` | OpenAI rate limit | Wait `retryAfter` seconds. v2 will add per-relay rate limiting; for now this is upstream behavior. |
| Function exceeds `maxDuration` (504 / function timeout) | Long generation, or stuck on a tool call | Verify `vercel.json` and route-level `maxDuration: 300` are both set. The Pro plan ceiling is 300s. |
| OpenAI dashboard shows usage on the wrong project | `OPENAI_API_KEY` from Preview leaked into Production (or vice versa) | Re-run §4 carefully — keys MUST come from different OpenAI projects. |

---

## 9. Non-goals (v1)

The following are intentionally NOT in this runbook because they are not in v1
(see [`ARCHITECTURE.md` §11](./ARCHITECTURE.md#11-future-work-v2-backlog) for the
v2 backlog):

- Rate limiting (Upstash, etc.)
- Daily token / dollar budget counters
- OAuth 2.1
- Sentry / OTel / Axiom observability
- Preview deploy comment bot
- Canary or blue-green deploys
