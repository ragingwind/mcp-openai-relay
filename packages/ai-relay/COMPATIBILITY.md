# `ai-relay` Runtime Compatibility

Last updated: see `git log -1 --format=%ad -- COMPATIBILITY.md`.

## Supported runtimes

| Runtime | Minimum version | Notes |
|---|---|---|
| Node.js | **20.10.0** | The `engines.node` field is `>=20`; the workspace pins `>=20.10.0 <21.0.0` for active development, but the SDK itself runs on every Node 20+ minor in CI. |
| Node.js (LTS / current) | 20.x, 22.x, 24.x | Smoke-tested per minor in `.github/workflows/runtime-matrix.yml`. |
| Bun | latest stable | Smoke-tested in CI with `oven-sh/setup-bun@v2`. |
| Cloudflare Workers | with `nodejs_compat` | Required for `AsyncLocalStorage` (request-scope error redaction). Without it, the SDK runs but the 5xx upstream-body redaction silently no-ops. |
| Deno | not officially supported | Likely works via the `npm:` specifier — untested. |

## Module format

- **ESM-only.** The published `exports` map has only an `import` condition;
  there is no `require` condition.
- A `require('ai-relay')` call from CommonJS code is expected to fail with
  `ERR_REQUIRE_ESM` on Node < 22. On Node 22+ with `require(esm)` enabled,
  the call may succeed and the documented shape is preserved. Both outcomes
  are validated by `tests/runtime-fixtures/cjs-require/smoke.cjs`.
- TypeScript consumers must use `moduleResolution: "bundler"` or
  `moduleResolution: "nodenext"`. Both are validated against the packed
  tarball by `packages/ai-relay/tests/integration/pack-contract.test.ts`.

## Public subpaths

| Subpath | Source | Exports |
|---|---|---|
| `ai-relay` | `dist/index.js` | `verifyBearer`, `loadConfig`, types |
| `ai-relay/openai` | `dist/openai/index.js` | `registerOpenAIChat`, `makeOpenAIChatHandler`, `mapOpenAIError`, `createOpenAIClient`, `openAIChatTool` + types |
| `ai-relay/anthropic` | `dist/anthropic/index.js` | `registerAnthropicMessages`, `makeAnthropicMessagesHandler`, `mapAnthropicError`, `createAnthropicClient`, `anthropicMessagesTool` + types |
| `ai-relay/env` | `dist/config.js` | `loadConfig` + config types |
| `ai-relay/auth` | `dist/auth.js` | `verifyBearer` |
| `ai-relay/logger` | `dist/logger.js` | `createLogger`, logger types |

The root `ai-relay` is intentionally a thin re-export of the common surface.
Heavier provider-specific code lives under its own subpath.

## Side-effect freeness at import time

- No top-level `process.env` reads.
- No globals patched.
- No fetch / network activity at module load.
- Snapshot-asserted by `tests/runtime-fixtures/smoke-node/smoke.mjs`.

## Adding a new runtime

See `tests/runtime-fixtures/README.md` for the per-cell smoke fixture
template and the CI workflow contract.
