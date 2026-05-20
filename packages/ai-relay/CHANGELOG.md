# Changelog

All notable changes to `ai-relay` are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project adheres to [Semantic Versioning](https://semver.org/) once
v1.0 ships. Pre-v1.0 minor bumps may include breaking changes — read
this file before upgrading.

## [Unreleased]

### Changed

- **`ai-relay-cli` binary removed.** `ai-relay` now auto-dispatches to
  one-shot CLI mode when ≥2 positionals are supplied (`<provider> <tool>`),
  and stays in MCP stdio server mode when only 1 positional is given.

  ```bash
  # MCP stdio server (unchanged)
  npx ai-relay openai -m gpt-4o-mini

  # One-shot CLI (was: npx --package=ai-relay ai-relay-cli openai chat-completions …)
  npx ai-relay openai chat-completions -m gpt-4o-mini "ping"
  ```

  Migration: replace every `ai-relay-cli <provider> <tool>` invocation
  with `ai-relay <provider> <tool>`. All flags and input forms are
  identical.

## [0.11.0] — 2026-05-14

### Added

- **Anthropic Messages provider** under the new `./anthropic` subpath
  (`ai-relay/anthropic`). Exposes `registerAnthropicMessages`,
  `registerAnthropicProvider`, `anthropicMessagesTool`,
  `makeAnthropicMessagesHandler`, `mapAnthropicError`, and the matching
  types. The caller-facing input/output schemas are identical to the
  OpenAI Chat Completions provider (`{ messages }` only, same result
  shape) — internal differences (leading `system` extraction, `stop` →
  `stop_sequences` translation, `stop_reason` → `finish_reason` mapping,
  `max_tokens` default of 1024) are confined to the registrar.
- `ai-relay anthropic` and `ai-relay-cli anthropic messages` bin
  invocations. The MCP tool name defaults to `messages`. Provider names
  are listed in `--help` output and the unknown-provider error message.
- Default `max_tokens: 1024` is applied at handler-build time when the
  Anthropic config omits it (Anthropic requires `max_tokens` on every
  call). The default is logged as `anthropic-max-tokens-default` under
  `--verbose`.

### Changed

- `peerDependencies` now declares both `openai` (`^6`) and
  `@anthropic-ai/sdk` (`^0.96.0`) as **optional** via
  `peerDependenciesMeta`. Existing OpenAI consumers see no install-time
  change; Anthropic consumers must install `@anthropic-ai/sdk` themselves.

### Refactor (internal — public API stable)

- `config.ts` — `providerConfigSchema` is now a `discriminatedUnion` over
  `provider`. The Anthropic branch enforces `temperature` range 0..1
  (vs OpenAI's 0..2) and `capability: "messages"`. `materialiseId` now
  produces `openai_chat` / `anthropic_messages` ids accordingly.
- `bin/registry.ts` — provider entries are loaded lazily via
  `import("../<provider>/index.js")`. `resolveProvider` and
  `resolveProviderTool` return promises. The eager `registry` const is
  replaced by a `providerNames: readonly ProviderName[]` export used for
  usage strings.
- `bin/run.ts` and `bin/ai-relay.ts` — the hardcoded
  `args.provider = "openai"` is replaced with the resolved
  `parsed.provider`, fixing a latent bug where a non-default provider
  selected on the CLI would still be passed as `openai` to `loadConfig`.

## [0.10.0] — 2026-05-13

### Changed (breaking)

- The caller-facing MCP tool `inputSchema` now accepts ONLY `messages`.
  `model`, `temperature`, `max_tokens`, `top_p`, and `stop` are no longer
  caller-overridable — they live entirely in the server config
  (`OpenAIChatConfig` for SDK embeds, `AI_RELAY_*` env vars for the
  HTTP server, `--model`/`--temperature`/`--max-tokens`/`--top-p`/`--stop`
  flags for the `ai-relay` and `ai-relay-cli` bins).
- `OpenAIChatConfig.model` is now REQUIRED. `makeOpenAIChatHandler` and
  `registerOpenAIChat` throw at boot when `model` is missing.
- `AI_RELAY_MODEL` is now a required environment variable in
  `app/src/env.ts` (the Hono server). Deployments that previously relied
  on a caller-supplied model MUST set `AI_RELAY_MODEL` explicitly.

### Added

- `AI_RELAY_TEMPERATURE`, `AI_RELAY_MAX_TOKENS`, `AI_RELAY_TOP_P`, and
  `AI_RELAY_STOP` environment variables — forwarded to every upstream
  OpenAI request when set. `AI_RELAY_STOP` accepts a single string or a
  comma-separated list.
- Matching `--temperature`, `--max-tokens`, `--top-p`, `--stop` flags on
  both `ai-relay` (MCP stdio launcher) and `ai-relay-cli` (one-shot CLI).
- `OpenAIChatConfig` gained `temperature`, `max_tokens`, `top_p`, and
  `stop` fields — all optional, forwarded as-is when set.

### Removed

- `AI_RELAY_MAX_OUTPUT_TOKENS` env var (replaced by `AI_RELAY_MAX_TOKENS`
  semantics). The previous behavior also clamped any caller-supplied
  `max_tokens` against this ceiling — both the env var AND the
  clamp logic are gone. The server forwards the configured value as-is.
- `OpenAIChatConfig.maxOutputTokensCeiling` field (replaced by the new
  per-request `max_tokens` server-config field).
- Caller-side support for `model` / `temperature` / `max_tokens` /
  `top_p` / `stop` in the MCP tool input. Senders that pass these
  fields will have them silently stripped by the MCP-SDK validator —
  the server-configured values are authoritative.

### Migration

```ts
// Before
registerOpenAIChat(server, { apiKey, maxOutputTokensCeiling: 4096 });

// After — model is required, sampling lives on the server config
registerOpenAIChat(server, {
  apiKey,
  model: "gpt-4o-mini",
  max_tokens: 4096,
  temperature: 0.7,
});
```

```sh
# Before — caller could vary the model per call
ai-relay openai

# After — model is server-configured (env or flag)
AI_RELAY_MODEL=gpt-4o-mini ai-relay openai
ai-relay openai -m gpt-4o-mini --temperature 0.7 --max-tokens 4096
```

## [0.9.0] — 2026-05-12

### Added

- `--verbose` / `AI_RELAY_VERBOSE=1` stderr trace now emits the full
  outbound OpenAI HTTP call (`openai-http-request`: method, URL,
  redacted Authorization header, full JSON body) and stream lifecycle
  events (`openai-stream-start`, `openai-stream-end`, `openai-cancelled`).
  MCP RPC tracing (`mcp-rpc-in`, `mcp-rpc-out`) now emits role + content
  verbatim instead of the previous `{ role, chars }` summary.
- `app/src/index.ts` (Hono server) now picks up `AI_RELAY_VERBOSE=1`
  and threads the same logger into `registerOpenAIChat`, so Docker /
  Cloud Run / Vercel deployments get the same trace surface as the
  stdio bin.
- New SDK subpath export: `ai-relay/logger` (`createVerboseLogger`,
  `isVerboseEnv`, `redactSecret`, `dumpMessages`, …) for callers
  embedding the relay in their own MCP server.

### Changed (caller-visible)

- Verbose line prefix renamed from `[verbose]` to `[ai-relay]`.
  Pool-prefixed hosts (e.g. `[pool:foo] [verbose] …`) now read
  `[pool:foo] [ai-relay] …` — disambiguates which process emitted
  the line.
- Verbose line format drops the ISO timestamp. Previous:
  `[verbose 2026-05-12T06:20:56.807Z] mcp-rpc-in: …`; current:
  `[ai-relay] mcp-rpc-in: …`. Capture pipelines that grep on the
  timestamp pattern need to update.
- SSE response bodies in `openai-http-response` are replaced with a
  placeholder (`<sse stream — see openai-stream-* events>`); the
  assembled completion appears in `openai-stream-end.accumulatedText`.
  Logging the SSE body verbatim would have consumed the stream before
  the SDK could read it.

### Policy

- `CLAUDE.md` §4 and `doc/ARCHITECTURE.md` §9 carve out an explicit
  exception to the "never log prompt/response bodies" rule for the
  `--verbose` debug stream. Secrets (`Authorization` header, env
  values matching `*_KEY` / `*_TOKEN`, `--api-key` argv) MUST still
  be redacted via `redactSecret()`. Operators MUST treat the verbose
  stderr stream as sensitive — never persist it to shared logging
  infrastructure, never include it in PR comments, never check it
  into git.

### Removed

- `summariseMessages()`-style chars-only redaction is no longer
  applied on the verbose path. The function remains exported as a
  legacy safety net but is no longer used by the bin tracers.
- `openai-request` and `openai-response-stream-end` stages from
  `ai-relay-cli` (run.ts) — superseded by the new HTTP / stream
  stages emitted from the SDK fetch wrapper and `runOnce()`.

## [0.8.1] — 2026-05-12

### Docs

- Rewrote root `README.md` / `README.ko.md` and `packages/ai-relay/README.md`
  around a single use-case-first layout. The top of each document is now a
  four-block Quick reference (one-shot CLI / stdio MCP / Docker HTTP / SDK
  embed) with complete copy-paste commands; the sections that follow contain
  only the detail not already in the quick block.
- Removed version-history, "migration from v0.1", "Status", and Docker
  smoke-harness sections — none of those help a first-time reader pick a
  deployment shape and ship.

No code or API changes.

## [0.8.0] — 2026-05-12

### Changed (BREAKING — caller-visible)

- **First positional is now `<provider>`, not `<api-type>`.** Both bins
  gained a provider axis that is separate from the tool name. The MCP
  tool registered on the server is still named `chat-completions` — the
  provider is conveyed by the positional (and by the fact that this
  server instance was started with `openai`), not baked into the tool
  name.

  MCP host configuration:
  ```diff
   "mcpServers": {
     "ai-relay": {
       "command": "npx",
  -    "args": ["-y", "ai-relay", "chat-completions"],
  +    "args": ["-y", "ai-relay", "openai"],
       "env": { "AI_RELAY_API_KEY": "sk-..." }
     }
   }
  ```

  One-shot CLI:
  ```diff
  -ai-relay-cli chat-completions -m gpt-4o-mini "ping"
  +ai-relay-cli openai chat-completions -m gpt-4o-mini "ping"
  ```

  The CLI now requires two positionals — `<provider>` then `<tool>` —
  looked up provider-scoped via the registry. Missing either, or an
  unknown provider / unknown tool for the named provider, exits 2 with
  a usage message.

- **Registry restructured.** `resolveApiType` is gone. The registry is
  keyed by provider:
  ```ts
  registry.openai = {
    registerOnServer: registerOpenAIProvider,
    tools: { "chat-completions": openAIChatTool },
  };
  ```
  Adding a future provider/API now means adding a registry entry rather
  than threading a new selector through the CLI parser.

### Rationale

Previously the server positional `<api-type>` and the registered tool
name were the same string (`chat-completions`), so the selector and the
identifier of the resulting tool were indistinguishable. Splitting the
two axes — provider as the positional, tool name as the registered
identifier — makes both bins extensible (multi-API and future
providers) without renaming `chat-completions`. Namespacing
(`<provider>.<api>`) is reserved for a future multi-provider-per-server
mode; see [`doc/ARCHITECTURE.md` §11](../../doc/ARCHITECTURE.md#11-future-work-v2-backlog).

## [0.7.0] — 2026-05-12

### Added

- **`--verbose` / `-v` flag (also `AI_RELAY_VERBOSE=1` env).** Both
  bins now accept a `--verbose` / `-v` flag, and either bin honors the
  `AI_RELAY_VERBOSE` environment variable (truthy values: `1`, `true`,
  `yes`, `on`; case-insensitive). Either source turns verbose on.

  When enabled the bin emits structured stage events to **stderr**:

  ```
  [verbose 2026-05-12T11:50:23.456Z] argv: [...]
  [verbose 2026-05-12T11:50:23.456Z] parsed-flags: {...}
  [verbose 2026-05-12T11:50:23.456Z] env-snapshot: {...}
  [verbose 2026-05-12T11:50:23.456Z] loaded-config: {...}
  [verbose 2026-05-12T11:50:23.456Z] openai-request: {...}
  [verbose 2026-05-12T11:50:23.456Z] openai-response-stream-end: {...}
  [verbose 2026-05-12T11:50:23.456Z] result: {...}
  ```

  For the MCP server (`ai-relay <api-type> --verbose`), additional
  events bracket the JSON-RPC traffic: `mcp-server-ready`,
  `mcp-rpc-in`, `mcp-rpc-out`. The stdout JSON-RPC channel is
  **never** polluted — every verbose line goes to stderr.

  Secrets (`AI_RELAY_API_KEY`, `AI_RELAY_AUTH_TOKEN`, `--api-key` flag
  values) are redacted to length-only markers
  (`***redacted(<n>chars)***`). OpenAI / MCP response bodies are
  reported as length + metadata; the body text itself never reaches
  stderr — that is reserved for the result on stdout.

  Usage:

  ```bash
  ai-relay-cli chat-completions -v -m gpt-4o-mini "ping"
  AI_RELAY_VERBOSE=1 ai-relay chat-completions
  ```

## [0.6.1] — 2026-05-12

### Fixed

- **`structuredContent` now reaches the client.** `registerOpenAIChat`
  previously called the deprecated `server.tool(name, description,
  inputSchema, handler)` 4-arg form, which omits the tool's
  `outputSchema` from the MCP `tools/list` response. Without an
  `outputSchema` declaration the SDK silently drops the
  `structuredContent` field on the way out, so callers received only
  the `content[0].text` body and lost the `model`, `usage`,
  `finish_reason` metadata. Switched to `server.registerTool(name,
  { description, inputSchema, outputSchema }, handler)` and exported
  `openAIChatOutputSchema` so consumers wiring the tool by hand can
  align with the same shape.

Symptom seen by a downstream MCP host (Backend.AI dol):
```diff
- output={"content":[{"type":"text","text":"…"}]}
+ output={"content":[{"type":"text","text":"…"}],
+         "structuredContent":{"model":"gpt-4o",
+           "usage":{"prompt_tokens":…,"completion_tokens":…,
+                    "total_tokens":…},
+           "finish_reason":"stop"}}
```

No API surface change for consumers using `registerOpenAIChat` —
they simply start receiving the structured result they were always
documented to get.

## [0.6.0] — 2026-05-12

### Changed (BREAKING — caller-visible)

- **Bin split into two binaries.** The single `ai-relay` dispatcher (which
  switched modes based on whether a positional was present) is gone. Now:
  - `ai-relay <api-type>` — MCP stdio server. The `<api-type>` positional
    (today `chat-completions`) is **required**; bare `ai-relay` exits with
    code 2 and a usage message. Unknown api-type also exits 2.
  - `ai-relay-cli <tool> [flags] [input]` — one-shot CLI. The previous
    `<model>` positional has been replaced by an optional `-m`/`--model`
    flag (see below).

  MCP host configuration:
  ```diff
   "mcpServers": {
     "ai-relay": {
       "command": "npx",
  -    "args": ["-y", "ai-relay"],
  +    "args": ["-y", "ai-relay", "chat-completions"],
       "env": { "AI_RELAY_API_KEY": "sk-..." }
     }
   }
  ```

  Shell invocation:
  ```diff
  -ai-relay chat-completions gpt-4o-mini "ping"
  +ai-relay-cli chat-completions -m gpt-4o-mini "ping"
  ```

- **`<model>` positional removed; replaced by flag + env.** `ai-relay-cli`
  no longer requires the model as a second positional argument. The model
  is resolved in this order (first match wins):
  1. `model` field inside the JSON input
  2. `-m` / `--model <id>` CLI flag
  3. `AI_RELAY_MODEL` environment variable

  Plain-text input with no model from any of the three sources exits 2
  with `no model resolved`. JSON input without a model is forwarded to
  the schema, which rejects it with a `model is required` error.

- **New env var `AI_RELAY_MODEL`.** CLI-only default model id, used when
  no `-m`/`--model` flag is passed and the JSON input does not carry
  `model`. The MCP server (`ai-relay <api-type>`) does not read this.

- **`cliRegistry` → `registry`.** The registry now holds
  `{ cli, registerMcp }` pairs per api-type so both bins share a single
  source of truth. `resolveTool(name)` still returns the CLI tool
  descriptor for one-shot use; new `resolveApiType(name)` returns the
  api-type key for MCP registration.

### Migration

| Before (0.5.x) | After (0.6.0) |
|---|---|
| `npx ai-relay` (MCP) | `npx ai-relay chat-completions` |
| `ai-relay chat-completions gpt-4o-mini "hi"` | `ai-relay-cli chat-completions -m gpt-4o-mini "hi"` |
| MCP host `"args": ["-y", "ai-relay"]` | MCP host `"args": ["-y", "ai-relay", "chat-completions"]` |
| `import { cliRegistry } from "ai-relay/…"` (internal) | `import { registry } from "ai-relay/…"` |

## [0.5.0] — 2026-05-12

### Changed (BREAKING — caller-visible)

- **Single bin `ai-relay` for both modes.** The standalone `ai-relay-mcp`
  binary is removed. Run `ai-relay` (no positional argument) to start
  the stdio MCP server; pass `<tool> <model> [input]` for the one-shot
  CLI. The MCP host configuration changes accordingly:
  ```diff
   "mcpServers": {
     "ai-relay": {
       "command": "npx",
  -    "args": ["-y", "--package=ai-relay", "ai-relay-mcp"],
  +    "args": ["-y", "ai-relay"],
       "env": { "AI_RELAY_API_KEY": "sk-..." }
     }
   }
  ```
- **CLI invocation order changed to `ai-relay <tool> <model> [input]`.**
  The `provider` positional and the `-m/--model` flag are removed; the
  tool name (first positional) now identifies which upstream API is
  invoked, and the model id is the second positional.
  ```diff
  -ai-relay openai chat -m gpt-4o-mini "ping"
  +ai-relay chat-completions gpt-4o-mini "ping"
  ```
- **Default MCP tool name `openai_chat` → `chat-completions`.** The
  tool name now follows the upstream API's native naming. Future
  provider tools will use the same convention — `messages` for
  Anthropic Messages, `responses` for OpenAI Responses, etc. Callers
  who explicitly registered with `name: "openai_chat"` keep that name;
  callers relying on the default must update `tools/call name`.
- **CLI tool registry is flat.** `cliRegistry.openai.chat` is now
  `cliRegistry["chat-completions"]`. `resolveTool(provider, tool)` is
  now `resolveTool(tool)`.

### Migration

| Before (≤ 0.4.x) | After (0.5.0) |
|---|---|
| `npx --package=ai-relay ai-relay-mcp` | `npx ai-relay` |
| `ai-relay openai chat -m gpt-4o-mini "hi"` | `ai-relay chat-completions gpt-4o-mini "hi"` |
| `tools/call { name: "openai_chat", … }` | `tools/call { name: "chat-completions", … }` |
| `resolveTool("openai", "chat")` | `resolveTool("chat-completions")` |

## [0.4.1] — 2026-05-12

### Fixed

- **`max_tokens: 0` now accepted as "use default"** — 0.4.0 rejected
  zero with `Too small: expected number to be >0`, which broke clients
  that emit `0` from a numeric input field to mean "no specific limit".
  Zero is now treated the same as omitted: the configured ceiling
  (default 4096) is injected. Negative values are still rejected.
  Positive values clamp to the ceiling as before.

## [0.4.0] — 2026-05-12

### Changed (BREAKING — caller-visible)

- **`max_tokens` defaults to the configured ceiling** when the caller
  omits it. Previously, an omitted `max_tokens` was passed through
  unset, leaving the upstream's own default in effect (often unbounded
  or model-specific). Every upstream call now carries an explicit cap
  — `maxOutputTokensCeiling` (default 4096; override with
  `AI_RELAY_MAX_OUTPUT_TOKENS` / `--max-tokens` / SDK
  `OpenAIChatConfig.maxOutputTokensCeiling`). Callers who relied on the
  upstream's larger default should set `max_tokens` explicitly. The
  clamp behaviour for caller-supplied values is unchanged.
- **`temperature` / `top_p` remain pass-through** — when the caller
  omits them they are not sent to the upstream, so the upstream's own
  defaults apply unchanged. Documented as a deliberate non-symmetry
  with `max_tokens`: the latter is a cost-defense boundary, the former
  two are sampling knobs whose OpenAI defaults (1.0 / 1.0) are stable.

### Fixed

- **`npx` invocation in docs** — 0.3.0 advertised `npx ai-relay-mcp`,
  which fails with `E404 'ai-relay-mcp@*' is not in this registry`
  because npx resolves the first argument as a package name. The bin
  lives inside `ai-relay`, so the correct form is
  `npx --package=ai-relay ai-relay-mcp`. Root `README.md`,
  `README.ko.md`, the SDK `README.md`, and the bin's `--help` USAGE
  block now show the correct command and `claude_desktop_config.json`
  arg array. (Originally staged as 0.3.1; rolled into 0.4.0.)

## [0.3.0] — 2026-05-11

### Added

- **`ai-relay-mcp` bin** — second binary that runs a long-lived stdio MCP
  server exposing the `openai_chat` tool. Intended for direct registration
  in MCP hosts (Claude Desktop, Claude Code, Cursor) via
  `claude_desktop_config.json`. Accepts the same flags as `ai-relay`
  (`--api-key`, `--base-url`, `--max-tokens`, `--timeout`, `--env`,
  `--help`, `--version`) and reads the same `AI_RELAY_*` env vars.
- **Integration tests for `ai-relay-mcp`** — six stdio JSON-RPC scenarios
  sharing the existing `npm pack` + tarball-install fixture.
- **`prepublishOnly` script** — runs `clean && build && test` so
  `pnpm publish` cannot proceed unless the SDK + bins build cleanly and
  all 132 tests pass.

### Fixed

- **`VERSION` constants** — both bins now report the package version
  (`--version` previously printed the placeholder `0.1.0`).

## [0.2.0] — 2026-05-11

First version actually published to npm. The `[0.1.0]` entry below was never
shipped to the registry and exists for historical reference only.

### Changed (BREAKING)

- **Package name** — published as `ai-relay` (unscoped). The repo previously
  drafted `@ragingwind/mcp-ai-relay` (#51) and `@ragingwind/ai-relay` (#54)
  before settling on the unscoped form. Consumers install via
  `npm install ai-relay`.
  > _If npm rejected the unscoped name at publish time, the actual published
  > name is `@ragingwind/ai-relay` — see `package.json` `name`._
- **Config model (#60)** — single `RelayConfig` shape consumed via
  `loadConfig()`. The 0.1.0-era `OPENAI_*` env schema (`OPENAI_API_KEY`,
  `OPENAI_BASE_URL`, `OPENAI_MAX_OUTPUT_TOKENS_CEILING`,
  `OPENAI_REQUEST_TIMEOUT_MS`) and the HTTP-only env schema have been
  removed.
- **CLI form (#61)** — one-shot `<provider> <tool>` form:
  `npx ai-relay openai completion-chat`. The previous flag form
  (`--openai-completion`) and the standalone `mcp-ai-relay` stdio bin
  alias have been removed.

### Changed

- `zod` runtime dep floor bumped `^4.3.6` → `^4.4.3` (#35). No API
  change; ensures consumers pull a version with the latest validator
  fixes.

### Removed

- `OPENAI_*` env vars (replaced by `RelayConfig` per #60)
- `mcp-ai-relay` stdio bin alias (collapsed into the single `ai-relay` bin per #61)

### Tested against

| Peer | Version |
|---|---|
| `@modelcontextprotocol/sdk` | `^1.26` |
| `openai` | `^6` (currently `6.37.x`) |
| `node` | `>=20.10` |

### Migration from 0.1.0 (repo-only consumers)

| Old | New |
|---|---|
| `npx mcp-ai-relay --openai-completion` | `npx ai-relay openai completion-chat` |
| `OPENAI_API_KEY=…` env-only | `RelayConfig` via `loadConfig()` |
| `import … from '@ragingwind/mcp-ai-relay'` | `import … from 'ai-relay'` |

## [0.1.0] — Never released, superseded by 0.2.0

> See 0.2.0 above for the actual first release.

First public release. Extracts the durable, framework-agnostic core of
[mcp-ai-relay](https://github.com/ragingwind/mcp-ai-relay) into a
publishable npm package.

### Added

- **CLI bin `mcp-ai-relay`** — zero-config stdio MCP server launcher.
  `npx -y ai-relay --openai-completion` registers the
  `completion_chat` tool and connects via stdio. Provider flag set is
  designed for forward extension (`--anthropic-messages`,
  `--gemini-generate`, `--ai-gateway-chat` reserved). `--name` and
  `--description` flags override the default tool descriptor; env vars
  (`OPENAI_API_KEY`, optional `OPENAI_BASE_URL`,
  `OPENAI_MAX_OUTPUT_TOKENS_CEILING`, `OPENAI_REQUEST_TIMEOUT_MS`)
  supply the runtime config. Multi-upstream registration stays a
  code-based use case — the CLI ships one tool per invocation.
- **`registerOpenAIChat(server, config)`** — register the
  `completion_chat` MCP tool on any `McpServer`. Each call creates an
  independent closure; the same server may be registered against
  multiple times with different `name` + `apiKey` + `baseURL` to expose
  multiple upstreams as distinct tools (OpenAI proper, Azure OpenAI,
  vLLM, Ollama, OpenRouter, Vercel AI Gateway in OpenAI mode).
- **`makeOpenAIChatHandler(config)`** — same factory exposed at handler
  granularity for advanced consumers (custom dispatchers, non-McpServer
  hosts, integration tests).
- **`verifyBearer(actual, expected)`** — constant-time bearer-token
  comparison using `TextEncoder` + a manual XOR-OR loop. Portable to
  Node, Bun, Deno, and Cloudflare Workers without `nodejs_compat`.
- **`parseEnv(source)`** (subpath `./env`) — opt-in zod-validated
  environment parser. Side-effect-free on import; the consumer chooses
  when to read `process.env`.
- **`createOpenAIClient(config)`** (subpath `./openai`) — lower-level
  factory exposing the OpenAI SDK instance + per-client
  `AsyncLocalStorage` scope used for upstream-error redaction.
- Subpath exports: `.`, `./auth`, `./env`, `./openai`. Future provider
  subpaths (`./anthropic`, `./gemini`, `./ai-gateway`) will be added
  without breaking existing consumers.

### Tested against

- Node.js 20.x (engine declaration)
- `@modelcontextprotocol/sdk@^1.26`
- `openai@^6`
- `mcp-handler@^1.1` (for Vercel/Next.js consumers)

### Notes for early adopters

- API surface is **stable in shape but pre-1.0** — minor bumps may
  refine names. v1.0 freezes the surface (planned after ≥4 weeks of
  dogfooding).
- `openai` is a peer dependency marked `optional`. The 0.1.0 SDK ships
  only the `./openai` subpath, so consumers do need it today —
  `peerDependenciesMeta.openai.optional = true` is forward-looking for
  the planned `./anthropic` / `./gemini` / `./ai-gateway` subpaths.
- `AsyncLocalStorage` is required for the upstream-body redaction
  feature. Workers must enable `compatibility_flags = ["nodejs_compat"]`;
  runtimes without AsyncLocalStorage get a no-op fallback (the SDK's
  default error message remains, just without the redacted snippet).
