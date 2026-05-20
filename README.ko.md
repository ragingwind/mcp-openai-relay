# ai-relay

> OpenAI Chat Completions(및 OpenAI 호환 업스트림) 또는 Anthropic Messages를 Model Context Protocol 도구로 노출하는 MCP 릴레이입니다.

> English: [README.md](./README.md)

---

## Providers

| Provider | CLI / bin | SDK 서브패스 | 비고 |
|---|---|---|---|
| OpenAI Chat Completions | `ai-relay openai` (MCP) / `ai-relay openai chat-completions` (단발 CLI) | [`ai-relay/openai`](./packages/ai-relay/README.md) | OpenAI 호환 업스트림 전반 (Azure, vLLM, Ollama, OpenRouter, AI Gateway) |
| Anthropic Messages | `ai-relay anthropic` (MCP) / `ai-relay anthropic messages` (단발 CLI) | [`ai-relay/anthropic`](./packages/ai-relay/README.md#anthropic-messages) | `max_tokens` 기본 1024, `temperature` 범위 0..1 |

> 배포된 프로세스는 한 번에 하나의 provider만 사용해야 합니다(ADR D8, [`doc/ARCHITECTURE.md`](./doc/ARCHITECTURE.md) 참고). 두 provider를 동시에 노출하려면 ai-relay 프로세스를 두 개 띄우세요.

---

## Quick reference

**1. 단발 CLI** — 셸에서 모델 호출:

```bash
# OpenAI
AI_RELAY_API_KEY=sk-... npx ai-relay openai chat-completions -m gpt-4o-mini "ping"

# Anthropic
AI_RELAY_API_KEY=sk-ant-... npx ai-relay anthropic messages -m claude-sonnet-4-5 "ping"
```

(`-m`은 CLI가 이번 호출에 사용할 모델을 서버 측 설정으로 박는 옵션입니다. MCP `tools/call` 인자로 전송되는 값이 **아닙니다**.)

**2. stdio MCP** — Claude Desktop / Claude Code / Cursor에 등록:

```json
{
  "mcpServers": {
    "ai-relay": {
      "command": "npx",
      "args": ["-y", "ai-relay", "openai", "-m", "gpt-4o-mini"],
      "env": { "AI_RELAY_API_KEY": "sk-..." }
    }
  }
}
```

MCP 호스트(Claude Desktop, Cursor 등)는 `tools/call` 호출 시 `{ "messages": [...] }`만 보냅니다. 모델은 서버 쪽에서 선택합니다 (위 예시처럼 `-m` 플래그 또는 `env`에 `AI_RELAY_MODEL` 추가).

**3. Docker HTTP** — MCP HTTP 엔드포인트 셀프 호스팅:

```bash
docker run -p 8787:8787 \
  -e AI_RELAY_API_KEY=sk-... \
  -e AI_RELAY_AUTH_TOKEN=$(openssl rand -hex 32) \
  -e AI_RELAY_MODEL=gpt-4o-mini \
  ghcr.io/ragingwind/ai-relay:latest
```

`AI_RELAY_MODEL`은 필수입니다 — 누락 시 Hono 서버가 부팅 단계에서 거부합니다.

**4. SDK** — 직접 만든 MCP 서버에 임베드:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerOpenAIChat } from "ai-relay/openai";

const server = new McpServer({ name: "my-relay", version: "0.1.0" });
registerOpenAIChat(server, {
  apiKey: process.env.AI_RELAY_API_KEY!,
  model: "gpt-4o-mini",
});
await server.connect(new StdioServerTransport());
```

`model`은 `OpenAIChatConfig`의 필수 필드입니다. 없으면 `registerOpenAIChat`이 부팅 시 throw합니다.

---

## 1. 단발 CLI

호출 형식: `ai-relay <provider> <tool> [flags] [input]`. 현재 `<provider>`는 `openai`, `<tool>`은 `chat-completions`. **모델과 샘플링 파라미터는 서버 사이드 설정** — `-m`/`--model`/`--temperature`/`--max-tokens`/`--top-p`/`--stop` 플래그 또는 대응되는 `AI_RELAY_*` env로 지정합니다. 입력은 위치 인자 또는 stdin 파이프 둘 중 하나(XOR); 평문은 `{messages:[{role:"user",content:…}]}`로 감싸지고, JSON 리터럴(`{` / `[`)은 그대로 전달되지만 `messages` 외 키는 `.strict()`가 거부합니다.

```bash
# 평문 입력 (자동으로 {messages:[…]} 로 감싸짐)
npx ai-relay openai chat-completions -m gpt-4o-mini "ping"

# JSON 입력 (messages만 — model 은 payload 가 아니라 flag/env 로)
npx ai-relay openai chat-completions -m gpt-4o-mini \
  '{"messages":[{"role":"user","content":"ping"}]}'

# stdin + 시스템 프롬프트 + 샘플링 오버라이드
echo "explain TLS in 2 sentences" \
  | npx ai-relay openai chat-completions -m gpt-4o-mini --temperature 0.2 -s "be terse"

# Azure OpenAI / vLLM / Ollama / AI Gateway 같은 OpenAI 호환 엔드포인트
npx ai-relay openai chat-completions -m gpt-4o-mini \
  --api-key sk-... --base-url https://my-azure.openai.azure.com/v1 "ping"
```

전체 플래그는 `npx ai-relay --help`. `-v` / `--verbose` (또는 `AI_RELAY_VERBOSE=1`)로 각 단계를 stderr로 추적; 시크릿은 마스킹되고 stdout JSON은 오염되지 않습니다.

---

## 2. stdio MCP 서버

자식 프로세스를 spawn해 stdin/stdout으로 JSON-RPC를 주고받는 모든 호스트(Claude Desktop, Claude Code, Cursor, 프로젝트 로컬 `.mcp.json`)에 `ai-relay`를 등록합니다. `AI_RELAY_API_KEY`와 모델 (`-m` 플래그 또는 `AI_RELAY_MODEL` env) 둘 다 지정하면 끝 — MCP 호스트는 `{ "messages": [...] }`만 보냅니다.

OpenAI 호환 엔드포인트로 가리키고, 샘플링도 서버에 박으려면:

```json
{
  "mcpServers": {
    "ai-relay": {
      "command": "npx",
      "args": ["-y", "ai-relay", "openai"],
      "env": {
        "AI_RELAY_API_KEY": "sk-...",
        "AI_RELAY_MODEL": "gpt-4o-mini",
        "AI_RELAY_BASE_URL": "https://my-azure.openai.azure.com/v1",
        "AI_RELAY_TEMPERATURE": "0.7",
        "AI_RELAY_MAX_TOKENS": "4096"
      }
    }
  }
}
```

bin은 `-m`/`--model`, `--api-key`, `--base-url`, `--max-tokens`, `--temperature`, `--top-p`, `--stop`, `--timeout`, `--env <path>` 플래그도 받습니다. flag와 env 어느 쪽이든 OK이지만 `AI_RELAY_MODEL` (또는 `-m`)은 필수입니다. 전체 목록은 `npx ai-relay --help`.

---

## 3. Docker HTTP 서버

컨테이너는 `http://localhost:8787/api/mcp`에서 MCP를 제공 (Bearer 인증: `AI_RELAY_AUTH_TOKEN`), `http://localhost:8787/healthz`에서 liveness probe를 제공합니다. 이미지는 멀티 아키텍처(amd64 + arm64), `ghcr.io/ragingwind/ai-relay:latest`.

Docker Compose:

```bash
docker compose up                            # 퍼블리시된 이미지 사용
docker compose -f compose.dev.yml up --build # 로컬 빌드
```

Hono 앱을 Vercel이나 다른 환경에 셀프 호스트하려면 [`examples/vercel/`](./examples/vercel/) 참고.

---

## 4. SDK 임베드

위는 stdio 변형입니다. 같은 `registerOpenAIChat`이 HTTP(Hono / Node)와 Cloudflare Workers에서도 동작합니다. 실행 가능한 예제:

- [`examples/stdio/`](./examples/stdio/) — stdio MCP 서버
- [`examples/multi-upstream/`](./examples/multi-upstream/) — 한 서버에 여러 OpenAI 호환 업스트림
- [`examples/cloudflare-workers/`](./examples/cloudflare-workers/) — Workers
- [`examples/vercel/`](./examples/vercel/) — Hono 앱의 Vercel 배포

SDK API 레퍼런스: [`packages/ai-relay/README.md`](./packages/ai-relay/README.md).

---

## 5. MCP Inspector 로 검증

[`@modelcontextprotocol/inspector --cli`](https://github.com/modelcontextprotocol/inspector) 가 stdio bin 을 자식 프로세스로 띄움 — HTTP 서버나 호스트 없이 한 줄로:

```bash
AI_RELAY_API_KEY=sk-... \
  npx @modelcontextprotocol/inspector --cli npx ai-relay openai -m gpt-4o-mini --method tools/list
```

기본이 아닌 업스트림 (Azure / vLLM / Ollama / AI Gateway / 자체 프록시) 을 쓰려면 `npx` 앞에 `AI_RELAY_BASE_URL=https://your-endpoint.example.com/v1` 추가.

전체 시나리오 매트릭스와 evidence 템플릿: [`doc/QA-MCP-INSPECTOR.ko.md`](./doc/QA-MCP-INSPECTOR.ko.md) ([English](./doc/QA-MCP-INSPECTOR.md)).

---

## 환경 변수

| 변수 | 필수 | 기본값 |
|---|---|---|
| `AI_RELAY_API_KEY` | 예 | — |
| `AI_RELAY_MODEL` | 예 (HTTP 앱; stdio bin은 `-m` 또는 이 env 필요) | — |
| `AI_RELAY_BASE_URL` | 아니오 | OpenAI 기본 |
| `AI_RELAY_TEMPERATURE` | 아니오 | 업스트림 기본 |
| `AI_RELAY_MAX_TOKENS` | 아니오 | 업스트림 기본 |
| `AI_RELAY_TOP_P` | 아니오 | 업스트림 기본 |
| `AI_RELAY_STOP` | 아니오 (단일 값 또는 콤마 분리 리스트) | — |
| `AI_RELAY_REQUEST_TIMEOUT_MS` | 아니오 | 60000 |
| `AI_RELAY_AUTH_TOKEN` | 예 (Docker / HTTP 앱) | — |
| `AI_RELAY_PORT` | 아니오 (HTTP 앱) | 8787 |

---

## 문서

- SDK API + 레시피: [`packages/ai-relay/README.md`](./packages/ai-relay/README.md)
- 아키텍처: [`doc/ARCHITECTURE.ko.md`](./doc/ARCHITECTURE.ko.md) ([English](./doc/ARCHITECTURE.md))
- 배포 런북: [`doc/DEPLOY.ko.md`](./doc/DEPLOY.ko.md) ([English](./doc/DEPLOY.md))

## 라이선스

MIT LICENSE
