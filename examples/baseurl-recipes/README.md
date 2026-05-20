# OpenAI-compatible upstream recipes

`AI_RELAY_BASE_URL` lets you point ai-relay at any OpenAI-compatible Chat Completions
upstream without code changes. This directory collects per-upstream configuration
snippets describing how to configure each upstream. All recipes are currently
`untested — community contributions welcome`; see the Status column. To submit a
verified recipe, follow the [Contributing](#contributing-a-verified-recipe) section below.

The MCP tool shape is unchanged — every recipe still exposes a single
`chat-completions` tool that accepts `{ messages }`. The upstream model and
sampling parameters are server-side configuration (`AI_RELAY_MODEL`,
`AI_RELAY_TEMPERATURE`, etc.). One process = one provider; switching upstream
is a config change, not a code change.

## Summary

| Upstream | Base URL | Auth | Model examples | Status |
|---|---|---|---|---|
| [xAI Grok](#xai-grok) | `https://api.x.ai/v1` | API key | `grok-3`, `grok-2-1212` | untested |
| [DeepSeek](#deepseek) | `https://api.deepseek.com/v1` | API key | `deepseek-chat`, `deepseek-reasoner` | untested |
| [Mistral](#mistral) | `https://api.mistral.ai/v1` | API key | `mistral-small-latest`, `mistral-large-latest` | untested |
| [Vercel AI Gateway](#vercel-ai-gateway) | `https://gateway.ai.vercel.app/v1` | Gateway token | `openai:gpt-4o`, `anthropic:claude-3-5-sonnet-20241022` | untested |
| [OpenRouter](#openrouter) | `https://openrouter.ai/api/v1` | API key | `openai/gpt-4o`, `anthropic/claude-3-5-sonnet`, `google/gemini-2.5-pro` | untested |
| [Ollama (local)](#ollama-local) | `http://localhost:11434/v1` | none (dummy key) | `llama3.2`, `qwen2.5-coder:7b` | untested |
| [vLLM (self-hosted)](#vllm-self-hosted) | `http://localhost:8000/v1` | optional (`EMPTY` for keyless) | served model id, e.g. `meta-llama/Llama-3-8B-Instruct` | untested |
| [LM Studio (local)](#lm-studio-local) | `http://localhost:1234/v1` | none (dummy key) | loaded model id | untested |
| Azure OpenAI | per-deployment endpoint | API key | per-deployment | see ARCHITECTURE.md |

> Azure OpenAI is documented in [doc/ARCHITECTURE.md §7](../../doc/ARCHITECTURE.md#7-environment-variables). No duplicate recipe here.

---

### xAI Grok

xAI exposes an OpenAI-compatible Chat Completions endpoint for the Grok family.
See the [xAI API docs](https://docs.x.ai/docs/api-reference) for the current
model catalogue and rate limits.

| Base URL | Auth | Streaming | Status |
|---|---|---|---|
| `https://api.x.ai/v1` | API key from <https://console.x.ai> | yes (SSE) | untested — community contributions welcome |

```bash
AI_RELAY_API_KEY=xai-...
AI_RELAY_BASE_URL=https://api.x.ai/v1
AI_RELAY_MODEL=grok-3
# Optional sampling overrides
# AI_RELAY_TEMPERATURE=0.7
# AI_RELAY_MAX_TOKENS=4096
# AI_RELAY_TOP_P=1.0
```

Model examples: `grok-3`, `grok-2-1212`.

Verify with the MCP Inspector CLI:

```bash
# MCP Inspector CLI — stdio transport
npx @modelcontextprotocol/inspector --cli \
  npx ai-relay openai -m grok-3 \
  --base-url https://api.x.ai/v1 --api-key xai-... \
  --method tools/call --tool-name chat-completions \
  --tool-arg '{"messages":[{"role":"user","content":"ping"}]}'
```

> **Status:** untested — community contributions welcome. To mark this verified, open a PR with MCP Inspector output as evidence.

---

### DeepSeek

DeepSeek exposes an OpenAI-compatible endpoint. See the
[DeepSeek API docs](https://api-docs.deepseek.com/) for the current model
catalogue (including the reasoning model `deepseek-reasoner`).

| Base URL | Auth | Streaming | Status |
|---|---|---|---|
| `https://api.deepseek.com/v1` | API key from <https://platform.deepseek.com> | yes (SSE) | untested — community contributions welcome |

```bash
AI_RELAY_API_KEY=sk-...
AI_RELAY_BASE_URL=https://api.deepseek.com/v1
AI_RELAY_MODEL=deepseek-chat
# Optional sampling overrides
# AI_RELAY_TEMPERATURE=0.7
# AI_RELAY_MAX_TOKENS=4096
# AI_RELAY_TOP_P=1.0
```

Model examples: `deepseek-chat`, `deepseek-reasoner`.

> `deepseek-reasoner` returns chain-of-thought tokens in addition to the assistant message. ai-relay forwards the upstream response as-is; downstream consumers may need to ignore the `reasoning_content` field.

Verify with the MCP Inspector CLI:

```bash
# MCP Inspector CLI — stdio transport
npx @modelcontextprotocol/inspector --cli \
  npx ai-relay openai -m deepseek-chat \
  --base-url https://api.deepseek.com/v1 --api-key sk-... \
  --method tools/call --tool-name chat-completions \
  --tool-arg '{"messages":[{"role":"user","content":"ping"}]}'
```

> **Status:** untested — community contributions welcome. To mark this verified, open a PR with MCP Inspector output as evidence.

---

### Mistral

Mistral's `la Plateforme` exposes an OpenAI-compatible Chat Completions endpoint.
See the [Mistral API docs](https://docs.mistral.ai/api/) for the current model
catalogue.

| Base URL | Auth | Streaming | Status |
|---|---|---|---|
| `https://api.mistral.ai/v1` | API key from <https://console.mistral.ai> | yes (SSE) | untested — community contributions welcome |

```bash
AI_RELAY_API_KEY=...
AI_RELAY_BASE_URL=https://api.mistral.ai/v1
AI_RELAY_MODEL=mistral-small-latest
# Optional sampling overrides
# AI_RELAY_TEMPERATURE=0.7
# AI_RELAY_MAX_TOKENS=4096
# AI_RELAY_TOP_P=1.0
```

Model examples: `mistral-small-latest`, `mistral-large-latest`.

> Mistral's `temperature` accepts the OpenAI 0..2 range. Some specialised models
> (e.g. `codestral-*`) have narrower recommended ranges — see Mistral docs.

Verify with the MCP Inspector CLI:

```bash
# MCP Inspector CLI — stdio transport
npx @modelcontextprotocol/inspector --cli \
  npx ai-relay openai -m mistral-small-latest \
  --base-url https://api.mistral.ai/v1 --api-key ... \
  --method tools/call --tool-name chat-completions \
  --tool-arg '{"messages":[{"role":"user","content":"ping"}]}'
```

> **Status:** untested — community contributions welcome. To mark this verified, open a PR with MCP Inspector output as evidence.

---

### Vercel AI Gateway

Vercel's [AI Gateway](https://vercel.com/docs/ai-gateway) is a multi-provider
proxy that exposes an OpenAI-compatible surface. Model ids are namespaced
`<provider>:<model>` so a single gateway token can reach OpenAI, Anthropic,
Google, and others.

| Base URL | Auth | Streaming | Status |
|---|---|---|---|
| `https://gateway.ai.vercel.app/v1` | Vercel AI Gateway token | yes (SSE) | untested — community contributions welcome |

```bash
AI_RELAY_API_KEY=vck_...
AI_RELAY_BASE_URL=https://gateway.ai.vercel.app/v1
AI_RELAY_MODEL=openai:gpt-4o
# Optional sampling overrides
# AI_RELAY_TEMPERATURE=0.7
# AI_RELAY_MAX_TOKENS=4096
# AI_RELAY_TOP_P=1.0
```

Model examples: `openai:gpt-4o`, `anthropic:claude-3-5-sonnet-20241022`.

> Anthropic-namespaced models accessed via the gateway run through Anthropic's
> backend. Sampling defaults still apply (`temperature` 0..1 for Anthropic).
> ai-relay does NOT translate ranges — set values valid for the namespaced provider.

Verify with the MCP Inspector CLI:

```bash
# MCP Inspector CLI — stdio transport
npx @modelcontextprotocol/inspector --cli \
  npx ai-relay openai -m openai:gpt-4o \
  --base-url https://gateway.ai.vercel.app/v1 --api-key vck_... \
  --method tools/call --tool-name chat-completions \
  --tool-arg '{"messages":[{"role":"user","content":"ping"}]}'
```

> **Status:** untested — community contributions welcome. To mark this verified, open a PR with MCP Inspector output as evidence.

---

### OpenRouter

[OpenRouter](https://openrouter.ai) aggregates many providers behind a single
OpenAI-compatible endpoint. Model ids use the `<provider>/<model>` form.

| Base URL | Auth | Streaming | Status |
|---|---|---|---|
| `https://openrouter.ai/api/v1` | API key from <https://openrouter.ai> | yes (SSE) | untested — community contributions welcome |

```bash
AI_RELAY_API_KEY=sk-or-...
AI_RELAY_BASE_URL=https://openrouter.ai/api/v1
AI_RELAY_MODEL=openai/gpt-4o
# Optional sampling overrides
# AI_RELAY_TEMPERATURE=0.7
# AI_RELAY_MAX_TOKENS=4096
# AI_RELAY_TOP_P=1.0
```

Model examples: `openai/gpt-4o`, `anthropic/claude-3-5-sonnet`, `google/gemini-2.5-pro`.

> OpenRouter recommends sending `HTTP-Referer` and `X-Title` headers for
> attribution. ai-relay does not surface custom headers in v1; OpenRouter will
> still serve requests without them.

Verify with the MCP Inspector CLI:

```bash
# MCP Inspector CLI — stdio transport
npx @modelcontextprotocol/inspector --cli \
  npx ai-relay openai -m openai/gpt-4o \
  --base-url https://openrouter.ai/api/v1 --api-key sk-or-... \
  --method tools/call --tool-name chat-completions \
  --tool-arg '{"messages":[{"role":"user","content":"ping"}]}'
```

> **Status:** untested — community contributions welcome. To mark this verified, open a PR with MCP Inspector output as evidence.

---

### Ollama (local)

[Ollama](https://ollama.com) exposes an OpenAI-compatible endpoint on
`http://localhost:11434/v1`. Authentication is not enforced, but the OpenAI SDK
requires a non-empty key — use any placeholder string (e.g. `ollama`).

| Base URL | Auth | Streaming | Status |
|---|---|---|---|
| `http://localhost:11434/v1` | none (any non-empty string accepted) | yes (SSE) | untested — community contributions welcome |

```bash
AI_RELAY_API_KEY=ollama
AI_RELAY_BASE_URL=http://localhost:11434/v1
AI_RELAY_MODEL=llama3.2
# Optional sampling overrides
# AI_RELAY_TEMPERATURE=0.7
# AI_RELAY_MAX_TOKENS=4096
# AI_RELAY_TOP_P=1.0
```

Model examples: `llama3.2`, `qwen2.5-coder:7b`.

> Requires `ollama serve` running locally and the target model already pulled
> (`ollama pull llama3.2`). Cold starts add multi-second latency on the first
> request — set `AI_RELAY_REQUEST_TIMEOUT_MS` higher than the default `60000`
> for large models on modest hardware.

Verify with the MCP Inspector CLI:

```bash
# MCP Inspector CLI — stdio transport
npx @modelcontextprotocol/inspector --cli \
  npx ai-relay openai -m llama3.2 \
  --base-url http://localhost:11434/v1 --api-key ollama \
  --method tools/call --tool-name chat-completions \
  --tool-arg '{"messages":[{"role":"user","content":"ping"}]}'
```

> **Status:** untested — community contributions welcome. To mark this verified, open a PR with MCP Inspector output as evidence.

---

### vLLM (self-hosted)

[vLLM](https://docs.vllm.ai) serves an OpenAI-compatible endpoint when started
with `vllm serve <model>`. The default port is `8000` and the served model id
must match `AI_RELAY_MODEL` exactly.

| Base URL | Auth | Streaming | Status |
|---|---|---|---|
| `http://localhost:8000/v1` (configurable) | optional API key from vLLM config (`EMPTY` for keyless) | yes (SSE) | untested — community contributions welcome |

```bash
AI_RELAY_API_KEY=EMPTY
AI_RELAY_BASE_URL=http://localhost:8000/v1
AI_RELAY_MODEL=meta-llama/Llama-3-8B-Instruct
# Optional sampling overrides
# AI_RELAY_TEMPERATURE=0.7
# AI_RELAY_MAX_TOKENS=4096
# AI_RELAY_TOP_P=1.0
```

Model examples: whatever model the vLLM process serves
(e.g. `meta-llama/Llama-3-8B-Instruct`, `mistralai/Mistral-7B-Instruct-v0.3`).

> `AI_RELAY_MODEL` must match the model id reported by `GET /v1/models` on the
> vLLM server — vLLM rejects requests for any other id. Use `--api-key` on the
> vLLM CLI to enable bearer auth; otherwise the placeholder `EMPTY` is the
> documented convention for keyless setups.

Verify with the MCP Inspector CLI:

```bash
# MCP Inspector CLI — stdio transport
npx @modelcontextprotocol/inspector --cli \
  npx ai-relay openai -m meta-llama/Llama-3-8B-Instruct \
  --base-url http://localhost:8000/v1 --api-key EMPTY \
  --method tools/call --tool-name chat-completions \
  --tool-arg '{"messages":[{"role":"user","content":"ping"}]}'
```

> **Status:** untested — community contributions welcome. To mark this verified, open a PR with MCP Inspector output as evidence.

---

### LM Studio (local)

[LM Studio](https://lmstudio.ai) exposes an OpenAI-compatible local server on
`http://localhost:1234/v1` once a model is loaded in the UI. Like Ollama, the
OpenAI SDK still requires any non-empty API key string.

| Base URL | Auth | Streaming | Status |
|---|---|---|---|
| `http://localhost:1234/v1` | none (any non-empty string accepted) | yes (SSE) | untested — community contributions welcome |

```bash
AI_RELAY_API_KEY=lm-studio
AI_RELAY_BASE_URL=http://localhost:1234/v1
AI_RELAY_MODEL=local-model
# Optional sampling overrides
# AI_RELAY_TEMPERATURE=0.7
# AI_RELAY_MAX_TOKENS=4096
# AI_RELAY_TOP_P=1.0
```

Model examples: whatever model is currently loaded in LM Studio (the UI shows
the id LM Studio expects; `GET /v1/models` also lists it).

> Requires the LM Studio "Local Server" feature to be running with a model
> loaded. Models load lazily — the first request after start-up may exceed the
> default timeout. Raise `AI_RELAY_REQUEST_TIMEOUT_MS` if needed.

Verify with the MCP Inspector CLI:

```bash
# MCP Inspector CLI — stdio transport
npx @modelcontextprotocol/inspector --cli \
  npx ai-relay openai -m local-model \
  --base-url http://localhost:1234/v1 --api-key lm-studio \
  --method tools/call --tool-name chat-completions \
  --tool-arg '{"messages":[{"role":"user","content":"ping"}]}'
```

> **Status:** untested — community contributions welcome. To mark this verified, open a PR with MCP Inspector output as evidence.

---

## Contributing a verified recipe

To mark a recipe as verified:
1. Test the recipe end-to-end using the verification snippet above
2. Open a PR editing this file: change `untested — community contributions welcome` to `✅ verified (linked PR)` and add the MCP Inspector output to the PR description
3. Link the PR in a comment on this file's `### <Upstream>` section
