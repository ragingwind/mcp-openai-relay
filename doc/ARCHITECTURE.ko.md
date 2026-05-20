# ARCHITECTURE — mcp-ai-relay

> English: [ARCHITECTURE.md](./ARCHITECTURE.md)

OpenAI Chat Completions API를 MCP(Model Context Protocol) 도구로 노출하는
릴레이 서버입니다. 최소한의 Hono HTTP 서버 위에 멀티 아키텍처 Docker
이미지(`ghcr.io/ragingwind/ai-relay`, amd64+arm64)로 배포됩니다.
커뮤니티가 유지보수하는 Vercel 배포 레시피는 `examples/vercel/`에 들어 있습니다.
Claude Code 같은 MCP 호스트가 호출하면 이 서버가 OpenAI를 호출해 응답을
호스트로 그대로 돌려줍니다.

이 문서는 v1 아키텍처의 단일 진실 원천(SSOT)입니다. 배경 리서치, 트레이드오프,
검토했던 대안은 [참고 자료](#참고-자료)의 출처를 참고하세요.

---

## 1. 핵심 결정 (v1)

| # | 결정 | 근거 (요약) |
|---|---|---|
| D1 | **Hono `^4` + `@hono/node-server`**, 단일 `/api/mcp` 라우트 + `/healthz` liveness | Web Request 네이티브, 런타임 약 30KB. Next.js 의존 없이 `mcp-handler`의 `(Request) => Promise<Response>` 시그니처와 그대로 맞물림 |
| D2 | **OpenAI Chat Completions API만 사용** (`/v1/chat/completions`) | 가장 보편적이고 안정적. Responses API, embeddings, image 도구는 v2 |
| D3 | **Bearer 공유 비밀 인증** (`withMcpAuth`) | 단일 사용자 / 소규모 사용 가정. OAuth 2.1은 v2 |
| D4 | **단순한 아키텍처** — observability, rate limiting, 외부 KV 없음 | observability는 나중. rate limiting과 budget cap은 v2 |
| D5 | **Node.js 20.x + 멀티 아키텍처 Docker** (`ghcr.io/ragingwind/ai-relay`, amd64+arm64) | 셀프 호스팅 가능. 클라우드/온프레미스 어디서나 이식 가능. Vercel 타깃은 `examples/vercel/`(커뮤니티 지원)로 이동 |
| D6 | **Streamable HTTP 트랜스포트만** (SSE 비활성) | Stateless. Redis 의존성 회피 |
| D7 | **OpenAI 스트림은 서버 측에서 누적해 단일 `CallToolResult`로 반환** | MCP `tools/call`은 단일 결과만 반환. 토큰 단위 스트리밍 채널 없음 |
| D8 | **환경변수 해석은 invocation 기반** | `AI_RELAY_*` 키는 호출된 provider에 따라 재해석되며, 한 서버에 여러 provider를 등록하는 것은 금지. §12.1 참고. |
| D9 | **도구 이름 네임스페이싱은 충돌 발생 시까지 보류** | 현재는 flat kebab-case 이름을 사용하며, 충돌이 생길 때만 `<provider>-<api>` 형태로 마이그레이션. 이름 변경 권한은 프로젝트가 보유. §12.2 참고. |
| D10 | **도구 입력 스키마는 업스트림 원형 그대로** | 각 도구의 호출자 스키마는 해당 업스트림 API의 네이티브 형태를 반영하며, provider 간 통합 메시지 추상화는 두지 않습니다. SDK 모듈이 구문 어댑터(예: Anthropic `system` 추출)를 수행합니다. §12.3 참고. |

---

## 2. 시스템 다이어그램

```
┌──────────────────────┐                ┌─────────────────────────────┐                 ┌───────────────────┐
│  MCP Host            │  Streamable    │  Relay  (Node 20.x, Hono)   │  HTTPS/SSE      │  OpenAI API       │
│  (Claude Code, etc.) │  HTTP + Bearer │  ghcr.io/ragingwind/ai-relay│  stream:true    │  /v1/chat/        │
│                      │ ─────────────► │  app/src/index.ts           │ ─────────────► │  completions      │
│                      │                │   ├─ GET /healthz → 200 ok  │                 │                   │
│                      │                │   ├─ ALL /api/mcp           │                 │                   │
│                      │                │   │   ├─ withMcpAuth(bearer)│                 │                   │
│                      │ ◄───────────── │   │   ├─ mcp-handler        │ ◄───────────── │                   │
│                      │  CallToolResult│   │   │   └─ chat-completions    │  delta chunks   │                   │
└──────────────────────┘                │   │   └─ accumulate stream  │                 └───────────────────┘
                                        │   │       → single text     │
                                        │   port: AI_RELAY_PORT       │
                                        │         (default 8787)      │
                                        └─────────────────────────────┘
                                                     │
                                                     ▼
                                          AI_RELAY_API_KEY
                                          AI_RELAY_AUTH_TOKEN
```

---

## 3. 요청 흐름 (happy path)

1. MCP 호스트가 `Authorization: Bearer <AI_RELAY_AUTH_TOKEN>` 헤더와 함께 `tools/call` JSON-RPC 메시지를 `POST /api/mcp`로 전송.
2. `withMcpAuth`가 헤더 토큰을 `AI_RELAY_AUTH_TOKEN` 환경변수와 timing-safe로 비교.
3. `mcp-handler`가 JSON-RPC를 파싱하고 `chat-completions` 도구 핸들러를 호출.
4. 도구 핸들러는 입력을 zod로 검증 → 서버 정책 `max_tokens` ceiling 적용 → `openai` SDK의 `chat.completions.create({ stream: true, ... })` 호출(`AbortController` 부착).
5. 업스트림 스트림을 async iterator(`for await (const chunk of stream)`)로 누적.
6. 누적된 텍스트와 `usage` 메타데이터를 `CallToolResult`로 직렬화:
   ```ts
   {
     content: [{ type: "text", text: "<accumulated assistant message>" }],
     structuredContent: { model, usage: { prompt_tokens, completion_tokens, total_tokens } },
     isError: false
   }
   ```
7. MCP 호스트의 클라이언트 LLM이 결과를 자신의 컨텍스트에 병합.

### 취소 / 연결 끊김
- MCP `notifications/cancelled` 수신 시 → `AbortController.abort()` → OpenAI 요청 종료(토큰 과금 중단).
- HTTP 클라이언트가 연결을 끊으면 Node HTTP 서버가 `request.signal`을 abort(Hono가 `c.req.raw`로 전달) → 동일한 경로로 전파.

### 오류 매핑
| 업스트림 | 응답 |
|---|---|
| 401/403 (auth) | `isError: true`, `code: "auth"` |
| 429 (rate limit) | `isError: true`, `code: "rate_limited"`, `retryAfter` |
| 400 `context_length_exceeded` | `isError: true`, `code: "context_length"` |
| 400 content policy | `isError: true`, `code: "content_policy"` |
| 5xx / network | `isError: true`, `code: "upstream_error"` |
| 기타 4xx | `isError: true`, `code: "bad_request"` |

비스트리밍 경로는 SDK 기본 retry(2회)를 사용. **스트리밍 경로는 `maxRetries: 0`** 으로 동작합니다(스트림 중 retry는 출력 중복을 야기).

---

## 4. MCP 도구 정의

### `chat-completions`

OpenAI Chat Completions를 한 번 호출하고 누적된 텍스트를 반환합니다.

**입력 스키마 (Zod, `.strict()`)**

| 필드 | 타입 | 필수 | 비고 |
|---|---|---|---|
| `messages` | `Array<{role: "system"|"user"|"assistant", content: string}>` | ✅ | OpenAI Chat 형태 |

호출자 측 surface는 의도적으로 최소화돼 있습니다 — `model` 과 모든 sampling 파라미터(`temperature`, `max_tokens`, `top_p`, `stop`)는 서버 인스턴스 단위로 구성되어 매 호출마다 자동으로 전달됩니다. 호출자가 `tools/call` 인자에 이 필드들을 포함시키면 MCP SDK 검증기가 핸들러 실행 전에 조용히 잘라냅니다.

**서버 측 구성 (`OpenAIChatConfig` / `AI_RELAY_*` env)**

| 필드 | Env | 필수 | 비고 |
|---|---|---|---|
| `model` | `AI_RELAY_MODEL` | ✅ | 업스트림 Chat Completions 엔드포인트로 그대로 전달 |
| `temperature` | `AI_RELAY_TEMPERATURE` | ❌ | 0..2; 설정 시 전달 |
| `max_tokens` | `AI_RELAY_MAX_TOKENS` | ❌ | 양의 정수; 그대로 전달 — 클램프 없음 |
| `top_p` | `AI_RELAY_TOP_P` | ❌ | 0..1; 설정 시 전달 |
| `stop` | `AI_RELAY_STOP` | ❌ | 단일 문자열 또는 쉼표로 구분된 목록 |

**출력 스키마**

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

**비고**:
- `tool_choice` / `tools` 파라미터는 v1에서 미지원 — tool call은 전달되지 않습니다.
- 응답에 function/tool call이 포함되면 텍스트로 직렬화하지 않습니다. 대신 `finish_reason: "tool_calls"`를 노출해 호스트 LLM이 후속 동작을 결정하도록 합니다.

### `messages` (Anthropic provider)

Anthropic Messages를 한 번 호출하고 누적된 어시스턴트 텍스트를 반환합니다. 호출자 측 입력/출력 스키마는 `chat-completions`와 동일합니다(D10 — 업스트림 충실 스키마 정책).

**입력 스키마 (Zod, `.strict()`)** — `chat-completions`와 동일:

| 필드 | 타입 | 필수 | 비고 |
|---|---|---|---|
| `messages` | `Array<{role: "system"|"user"|"assistant", content: string}>` | ✅ | 선두의 `system` 메시지는 Anthropic 최상위 `system` 필드로 추출(다수일 경우 `\n\n`으로 결합); 선두가 아닌 `system`은 `bad_request`로 거부 |

**서버 측 구성 (`AnthropicMessagesConfig` / `AI_RELAY_*` env)**

| 필드 | Env | 필수 | 비고 |
|---|---|---|---|
| `model` | `AI_RELAY_MODEL` | ✅ | 업스트림 Messages 엔드포인트로 그대로 전달 |
| `temperature` | `AI_RELAY_TEMPERATURE` | ❌ | **0..1** (OpenAI는 0..2); 설정 시 전달 |
| `max_tokens` | `AI_RELAY_MAX_TOKENS` | ❌ | 양의 정수. **생략 시 `1024`로 기본값 적용** — Anthropic은 매 호출마다 이 필드를 요구합니다 |
| `top_p` | `AI_RELAY_TOP_P` | ❌ | 0..1; 설정 시 전달 |
| `stop` | `AI_RELAY_STOP` | ❌ | 단일 문자열 또는 쉼표로 구분된 목록; 업스트림으로는 `stop_sequences: string[]`로 변환 |

**출력 스키마** — `chat-completions`와 동일 (`structuredContent.model`, `usage`의 `prompt_tokens` + `completion_tokens` + `total_tokens`, `finish_reason`, `code`, `retryAfter`).

#### Anthropic `stop_reason` → `finish_reason` 매핑

| Anthropic `stop_reason` | 노출되는 `finish_reason` | 비고 |
|---|---|---|
| `end_turn` | `stop` | 정상 완료 |
| `max_tokens` | `length` | 상한 도달 |
| `stop_sequence` | `stop` | `stop_sequences` 중 하나와 매치 |
| `tool_use` | `tool_calls` | OpenAI `tool_calls`와 동일(v1에서는 tool 전달하지 않음) |
| `refusal` | `content_filter` | `isError: true` + `code: "content_policy"`도 함께 설정 |

---

## 5. 디렉터리 구조

```
mcp-ai-relay/                              # 저장소 루트 — pnpm 워크스페이스 오케스트레이터
├── app/                                # private 워크스페이스 패키지 — Hono HTTP 서버
│   ├── src/
│   │   ├── index.ts                    # MCP 진입점 — Hono app: GET /healthz + ALL /api/mcp
│   │   └── env.ts                      # AI_RELAY_* env 검증 (zod, 값 비노출)
│   ├── package.json                    # private; deps: hono, @hono/node-server, mcp-handler, ai-relay (workspace:*)
│   ├── tsconfig.json
│   └── Dockerfile                      # multi-stage; alpine; pnpm deploy --prod로 런타임 트리 생성
├── packages/
│   └── ai-relay/                       # 배포 가능한 SDK
│       ├── src/
│       │   ├── index.ts                # 공개 re-export (auth)
│       │   ├── auth.ts                 # verifyBearer (portable, node:crypto 불필요)
│       │   ├── bin/
│       │   │   ├── ai-relay.ts         # bin 진입점 — `ai-relay <provider>` MCP stdio 서버; 위치 인자가 2개 이상이면 `ai-relay <provider> <tool> [flags] [input]` 단발 CLI 모드로 자동 디스패치
│       │   │   ├── mcp-server.ts       # startMcpServer({apiType,config}) — 순수 라이브러리 함수
│       │   │   ├── run.ts              # 단발 CLI 오케스트레이터(자동 디스패치된 CLI 모드에서 사용)
│       │   │   ├── parse.ts            # parseArgv (CLI) + parseMcpArgv (MCP)
│       │   │   ├── registry.ts         # api-type → {cli, registerMcp} 매핑
│       │   │   └── env-file.ts         # 최소 dotenv 파서
│       │   └── openai/
│       │       ├── index.ts            # provider re-export
│       │       ├── chat.ts             # registerOpenAIChat + makeOpenAIChatHandler
│       │       └── client.ts           # createOpenAIClient 팩토리
│       ├── tests/
│       │   ├── setup-env.ts
│       │   └── unit/
│       │       ├── auth.test.ts
│       │       ├── chat.test.ts
│       │       ├── env.test.ts
│       │       └── multi-registration.test.ts
│       ├── package.json                # exports map + peerDeps + tsc 빌드
│       ├── tsconfig.json               # 루트 extends (typecheck 모드)
│       ├── tsconfig.build.json         # npm consumer용 dist/ 생성
│       └── vitest.config.ts
├── tests/
│   ├── setup-env.ts                    # integration 테스트용 process.env 시드
│   └── integration/
│       ├── route.test.ts               # app/src/index.ts에서 `{ app }` 가져와 app.fetch(request) 호출
│       └── app-env.test.ts             # app/src/env.ts 검증(AI_RELAY_AUTH_TOKEN, AI_RELAY_PORT)
├── scripts/
│   ├── verify.mjs                      # pnpm dev 대상 자동 C1/C2/C5 스모크
│   ├── mcp-inspect.mjs                 # MCP Inspector CLI 래퍼 — 단발 tools/call
│   └── check-dev-env.mjs               # pnpm dev 사전 env 점검
├── examples/
│   └── vercel/                         # 커뮤니티 지원 Vercel 배포 레시피
│       ├── README.md
│       └── vercel.json                 # 기존 루트 설정(maxDuration + region 고정)
├── .github/workflows/
│   ├── ci.yml                          # PR마다 typecheck + lint + build + test
│   └── release-app.yml                 # `v*` 태그에서 멀티 아키텍처 buildx → ghcr push
├── doc/
│   ├── ARCHITECTURE.md                 # 본 문서의 영문 정본 — 설계 SSOT
│   ├── DEPLOY.md                       # Docker + Vercel 런북
│   └── QA-MCP-INSPECTOR.md             # 수동 검증 절차
├── CLAUDE.md                           # AI 에이전트 협업 가이드
├── compose.yml                         # production: ghcr.io/ragingwind/ai-relay:latest를 pull
├── compose.dev.yml                     # local-build: app/Dockerfile에서 빌드
├── pnpm-workspace.yaml                 # workspace에 packages/* + examples/* + app 등록
├── package.json                        # 워크스페이스 오케스트레이터; ai-relay (workspace:*)에 의존
├── tsconfig.json
├── biome.json
├── vitest.workspace.ts                 # SDK unit + integration 프로젝트
├── .env.example
└── .gitignore
```

---

## 6. 기술 스택 (확정)

| 분야 | 선택 |
|---|---|
| Framework | Hono `^4` + `@hono/node-server` `^1.13` |
| MCP handler | `mcp-handler@^1.1` |
| MCP SDK | `@modelcontextprotocol/sdk@^1.26` |
| Validation | `zod@^4` |
| OpenAI SDK | `openai@^6` (optional peer dep) |
| Anthropic SDK | `@anthropic-ai/sdk@^0.96.0` (optional peer dep) |
| Runtime | Node.js `20.x` (alpine 컨테이너; 멀티 아키텍처 amd64+arm64) |
| Language | TypeScript strict, NodeNext ESM, `verbatimModuleSyntax: true` |
| Package manager | pnpm `^9` (`packageManager` 필드로 고정) |
| Lint/Format | Biome `^2` |
| Test | vitest + msw (HTTP 경계에서만 mock) |
| Deployment | `ghcr.io/ragingwind/ai-relay` 멀티 아키텍처 이미지; production은 `compose.yml`, 로컬 빌드는 `compose.dev.yml`. Vercel 레시피는 `examples/vercel/`(커뮤니티 지원). |
| SDK 빌드 | `tsc -p tsconfig.build.json` → `packages/ai-relay/dist/`; ESM. peerDeps: `@modelcontextprotocol/sdk`(필수); `openai`와 `@anthropic-ai/sdk`는 optional — 실제 사용하는 provider의 SDK만 설치 |
| App 빌드 | `tsc -p app/tsconfig.json` → `app/dist/`; 런타임 이미지는 `pnpm deploy --prod /deploy`로 자체 완결 트리 생성 |

### 컨테이너 릴리스

[`.github/workflows/release-app.yml`](../.github/workflows/release-app.yml)이
`v*` 태그가 푸시될 때마다(그리고 `workflow_dispatch`로 수동 실행 시) 멀티
아키텍처 이미지(amd64 + arm64)를 빌드해 푸시합니다:

- `ghcr.io/ragingwind/ai-relay:vX.Y.Z` — 버전 태그
- `ghcr.io/ragingwind/ai-relay:latest` — 기본 브랜치에서 푸시될 때 갱신
- 이미지에 헬스체크가 내장(`HEALTHCHECK ... /healthz`)되어 있으며 `compose.yml`이 이를 그대로 상속.

### Vercel 레시피 (커뮤니티 지원)

`examples/vercel/vercel.json`은 원래의 `regions: ["iad1"]` +
`functions[..].maxDuration: 300` 모양을 그대로 유지합니다. 배포하려면 npm의
`ai-relay`를 소비하는 얇은 Next.js 프로젝트를 만드세요(자세한 내용은
`examples/vercel/README.md` 참고).

### `tsconfig.json` 핵심
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

## 7. 환경변수

`AI_RELAY_*` 키는 invocation 시점에 지정된 provider(`ai-relay <provider>`)에 따라 해석됩니다. 한 프로세스는 정확히 하나의 provider만 서비스하며, 동일한 MCP 서버에 여러 provider를 동시에 실행하는 구성은 지원하지 않습니다(§12.1 참고).

| 키 | 필수 | 비밀 | 설명 |
|---|---|---|---|
| `AI_RELAY_API_KEY` | ✅ | Sensitive | 업스트림 API 키. Production/Preview용 키 분리 권장. |
| `AI_RELAY_AUTH_TOKEN` | ✅ | Sensitive | MCP 호스트가 보내는 Bearer 토큰. 32바이트 이상 random. |
| `AI_RELAY_MODEL` | ✅ | Plain | 매 `tools/call`마다 전달되는 업스트림 model id. 호출자 측 도구 입력은 이제 `model`을 받지 않습니다. |
| `AI_RELAY_BASE_URL` | ❌ | Plain | 업스트림 base URL 오버라이드. 기본: SDK 내장. Azure OpenAI, 셀프 호스팅 vLLM/Ollama 게이트웨이, 로컬 mock을 가리킬 때 사용. |
| `AI_RELAY_TEMPERATURE` | ❌ | Plain | 실수. 범위는 provider에 따라 다름: **`openai`는 0..2**, **`anthropic`은 0..1**. 설정 시 매 업스트림 호출에 `temperature`로 전달. |
| `AI_RELAY_MAX_TOKENS` | ❌ | Plain | 양의 정수. 매 업스트림 호출에 `max_tokens`로 그대로 전달. 서버 측 클램프 없음 — 보수적으로 설정. `anthropic`의 경우 생략 시 `1024`가 기본값으로 적용됩니다(Anthropic은 매 호출마다 이 필드를 요구). |
| `AI_RELAY_TOP_P` | ❌ | Plain | 0..1 실수. 설정 시 매 업스트림 호출에 `top_p`로 전달. |
| `AI_RELAY_STOP` | ❌ | Plain | 단일 값 또는 쉼표로 구분된 목록(`END` 또는 `END,STOP`). 매 업스트림 호출에 `stop`으로 전달. |
| `AI_RELAY_REQUEST_TIMEOUT_MS` | ❌ | Plain | 정수. 기본 `60000`. 업스트림 호출 타임아웃. |
| `AI_RELAY_PORT` | ❌ | Plain | 정수 1..65535. 기본 `8787`. Hono 서버 바인드 포트. |

`.env.example`에는 키 이름만 기록하고 값은 절대 커밋하지 마세요. 비밀은 컨테이너 오케스트레이터의 시크릿 저장소(Docker `--env-file`, k8s Secret 등)에 등록합니다. Vercel 커뮤니티 레시피는 Vercel의 Sensitive env vars를 사용합니다.

---

## 8. 인증 (v1)

```ts
// lib/auth.ts (개념)
import { timingSafeEqual } from "node:crypto";

export function verifyToken(req: Request, bearerToken: string | undefined) {
  if (!bearerToken) return undefined;            // 미인증
  const expected = process.env.AI_RELAY_AUTH_TOKEN;
  if (!expected) return undefined;                // fail-closed
  const a = Buffer.from(bearerToken);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return undefined;
  if (!timingSafeEqual(a, b)) return undefined;
  return { clientId: "shared-secret", scopes: ["openai:chat"] };
}
```

라우트 핸들러는 `withMcpAuth(handler, verifyToken, { required: true, requiredScopes: ["openai:chat"] })`로 래핑합니다.
미인증 요청에는 `mcp-handler`가 자동으로 401 + `WWW-Authenticate` + `/.well-known/oauth-protected-resource` 헤더를 응답합니다.

> v2에서 OAuth 2.1로 진화할 때는 `verifyToken`만 교체하면 됩니다 — 라우트 시그니처는 그대로입니다.

---

## 9. 보안 — v1 최소 셋

- 응답, 로그, 오류 메시지에 `AI_RELAY_API_KEY`를 절대 노출하지 않습니다.
- Bearer 토큰은 항상 `timingSafeEqual`로 비교합니다.
- 모든 도구 입력은 zod로 엄격하게 검증합니다(`.strict()` 사용).
- `max_tokens`는 호출자 값을 받되 서버 ceiling으로 클램프합니다.
- `console` 로그는 메타데이터(model, token counts, latency, status)만 포함합니다. **기본/info 레벨에서는 prompt/response 본문을 절대 로그에 남기지 않습니다.**
- **`--verbose` 예외**: `--verbose` 플래그나 `AI_RELAY_VERBOSE=1`로 명시적으로 활성화된 경우, stderr 추적은 전체 request/response 본문(도구 인자, 누적된 어시스턴트 텍스트, OpenAI HTTP 본문)을 출력할 수 있습니다. 비밀 — API 키, bearer 토큰, `Authorization` 헤더 값, 이름이 `*_KEY`/`*_TOKEN`과 매칭되는 env 변수 — 는 `redactSecret()`으로 계속 마스킹됩니다. verbose 스트림은 운영자 전용 진단 출력입니다: 공유 로깅, PR 댓글, git에 절대 영속화하지 마세요. 운영 정책은 [CLAUDE.md §4](../CLAUDE.md#4-coding-conventions-repo-specific) 참고.
- 컨테이너 이미지는 비-root `app` 유저(uid 1001)로 실행됩니다. 오케스트레이터에서 root로 덮어쓰지 마세요.
- 배포되는 이미지는 기본 private입니다. 공개 준비가 끝났을 때만 Settings → Packages → ai-relay에서 public으로 전환하세요.

### v1 미포함 (의도적)
- Rate limiting (Upstash 등)
- 일별 토큰/달러 budget 카운터
- OAuth 2.1
- 외부 observability (Sentry, OTel, Axiom)
- 호출자별 사용량 추적

위 항목들은 §11에 v2 후보로 정리했습니다.

---

## 10. 테스트 전략 (v1)

| 레이어 | 도구 | 범위 |
|---|---|---|
| Unit (SDK) | vitest + msw, `packages/ai-relay/` 안에서 실행 | `verifyBearer`, `parseEnv`, `registerOpenAIChat` 팩토리 — 입력 검증, max_tokens 클램프, 오류 매핑 |
| Multi-registration | vitest + msw, 실제 `McpServer` | 같은 server에 다른 `name` + `apiKey` + `baseURL`로 여러 번 등록 — 각 핸들러가 자기 업스트림으로 라우팅되고 상호 영향 없음 |
| Integration | vitest, Hono `app.fetch(request)`를 Web `Request`/`Response`로 직접 호출 | Bearer auth (있음/없음/잘못됨), MCP `tools/list` / `tools/call` JSON-RPC 흐름, `/healthz` liveness, `AI_RELAY_PORT` 검증 |
| Manual E2E | MCP Inspector | 로컬에서 `pnpm dev` → `npx @modelcontextprotocol/inspector` → Streamable HTTP, `http://localhost:8787/api/mcp`에 연결 |

원칙: **OpenAI HTTP 경계에서만 mock합니다**(MSW). SDK 모듈 자체는 절대 mock하지 마세요 — SDK 업그레이드를 놓칠 위험이 너무 큽니다.

---

## 11. v2+ 백로그

- **Responses API 지원** (`responses` 도구 추가 — §12.2 네이밍 정책 참고)
- **Embeddings / image** 도구
- **OAuth 2.1** 인증 (`withMcpAuth`의 토큰 검증기 교체)
- **Rate limiting** — Upstash Ratelimit (Edge Middleware, IP + 토큰 2단)
- **Budget cap** — Upstash Redis 기반 일별 토큰/달러 카운터
- **Observability** — OpenTelemetry traces + Pino NDJSON 로그 + (선택) Sentry
- **Progress notifications** — `_meta.progressToken` 처리, 진행 메시지 발행
- **Tools/function-calling pass-through** — `tool_calls` 결과를 `structuredContent`로 직렬화

---

## 12. 아키텍처 정책

본 정책들은 SDK가 단일 provider를 넘어 확장될 때의 규칙을 정합니다. 이슈 #91 (Anthropic), #92 (OpenAI Responses), #93 (Google Gemini) 및 향후 provider 작업이 모두 이 정책에 의존합니다.

### 12.1 환경변수 해석 (D8)

`AI_RELAY_*` env 키는 어떤 provider가 사용되든 이름을 그대로 유지하지만, 그 **의미는 invocation 시점에 지정된 provider에서 파생**됩니다:

- `ai-relay openai`     → `AI_RELAY_API_KEY`는 OpenAI 키, `AI_RELAY_MODEL`은 OpenAI 모델 id(`gpt-5-mini`).
- `ai-relay anthropic`  → 같은 키들이 Anthropic용으로 해석됨(`claude-sonnet-4-6`, …).
- `ai-relay google`     → 같은 키들이 Gemini용으로 해석됨(`gemini-2.5-pro`).

**한 서버에 여러 provider를 동시에 두는 구성은 지원하지 않습니다.** 한 프로세스는 정확히 하나의 provider만 서비스하며, 동일 MCP 서버에 `openai`와 `anthropic` 도구를 함께 등록하는 것은 범위를 벗어납니다. 여러 provider가 필요한 운영자는 각 provider invocation과 env를 분리한 별도의 프로세스를 실행합니다.

근거: 환경변수 이름이 폭발적으로 늘어나는 것(`AI_RELAY_OPENAI_API_KEY` / `AI_RELAY_ANTHROPIC_API_KEY` / …)을 피하고, 운영자들이 실제 배포하는 패턴(업스트림 1개당 컨테이너 1개)과 일치합니다.

### 12.2 도구 이름 네임스페이싱 (D9)

MCP 도구 이름은 충돌이 발생하지 않는 한 flat kebab-case를 유지합니다:

| Provider   | 도구 이름            |
|------------|---------------------|
| OpenAI     | `chat-completions`  |
| OpenAI     | `responses`         |
| Anthropic  | `messages`          |
| Google     | `generate-content`  |

실제 이름 충돌이 발생하면(예: 향후 provider가 `messages`를 정의), 도구 이름을 `<provider>-<api>` 형태(`anthropic-messages`, `gemini-messages`, …)로 단일 조정 릴리스에서 마이그레이션합니다. **프로젝트는 충돌 시 도구를 리네임할 권리를 보유합니다.** flat 이름에 의존하는 얼리어답터는 이 마이그레이션을 예상해야 합니다.

근거: 필요해지기 전에 네임스페이스를 미리 붙이는 것은 과도한 설계입니다. 마이그레이션 비용은 작고(리네임 + minor 버전 업), 지금 항상 네임스페이스를 붙이는 비용이 더 큽니다(보기 흉한 이름, flat 이름을 이미 출시한 v0.x 소비자에게 깨짐).

### 12.3 스키마 정책 (D10)

각 MCP 도구의 입력은 **해당 업스트림 API의 네이티브 형태**를 그대로 노출합니다. provider 간 통합 메시지 추상화는 두지 않습니다. 업스트림 형태가 호출자 측 관례와 다른 경우, SDK 모듈이 내부에서 **변환(translation)**을 수행하며, 두 provider가 동일한 표면을 가진 척하는 정규화(normalization)는 절대 수행하지 않습니다.

구체 예시(Anthropic): 호출자는 OpenAI Chat 형태와 동일하게 `{ messages: [{ role: 'system' | 'user' | 'assistant', content: string }] }`로 전달합니다. Anthropic SDK 모듈은 선행 `role: 'system'` 항목들을 Anthropic의 최상위 `system: string` 파라미터로 추출한 뒤 `client.messages.create(...)`를 호출합니다. 이는 **구문 어댑터(syntactic adapter)**이지 스키마 통합이 아닙니다. OpenAI Chat과 Anthropic Messages의 호출자 스키마는 독립적으로 버전 관리됩니다.

근거: 통합된 형태가 존재하는 척하면 스키마 경계에서 거짓을 만들고, provider들이 발산할수록 썩어 갑니다. Gemini의 `contents`/`parts` 형태가 이 문제의 가장 가까운 예입니다 — 강제 정규화는 향후 provider 기능이 필요로 할 정보를 잃게 만듭니다.

---

## 참고 자료

### MCP 사양 / SDK
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

### Vercel 플랫폼
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

### 도구 / 라이브러리
- [Zod](https://zod.dev/)
- [Biome](https://biomejs.dev/)
- [Vitest](https://vitest.dev/)
- [MSW](https://mswjs.io/)
