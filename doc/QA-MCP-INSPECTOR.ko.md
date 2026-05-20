# QA — MCP 검증

> English: [QA-MCP-INSPECTOR.md](./QA-MCP-INSPECTOR.md)

이것이 v1의 **유일한 검증 절차**입니다. 모든 PR 머지 전에 한 번, 모든
production 배포 후에 한 번 실행하세요. v1은 UI가 없기 때문에
(`CLAUDE.md` §3에 따라 `evidence-mode: none`) 자동 브라우저 증거가
없습니다. MCP Inspector가 실제 OpenAI API 호출에 대한 end-to-end 검증의
가장 가까운 대체재입니다.

두 가지 방식:

- **자동 스모크** — `pnpm verify`가 C1, C2, C5를 ~10초 안에 커버. 대부분의
  PR에 사용.
- **수동 5-시나리오** — C4(서버 측 sampling 오버라이드) 또는 C6(취소)이
  범위에 들어올 때, 그리고 모든 production 배포 후에 필요.

> 호출자 측 MCP 도구 입력은 `{ messages }` 만 받습니다. `model`,
> `temperature`, `max_tokens`, `top_p`, `stop` 은 서버 측 구성
> (Hono 앱의 env 변수, stdio bin의 플래그)입니다. 아래 시나리오는
> 서버의 `AI_RELAY_MODEL` / `AI_RELAY_MAX_TOKENS` 에 대해 단언합니다.

**시간 예산**: 환경 세팅이 끝난 뒤 수동 절차는 ~3분.

> **Playwright 등 자동화 시나리오와 주기적 production health check** 는
> [`ARCHITECTURE.ko.md` §11](./ARCHITECTURE.ko.md#11-v2-백로그) 참고 — 둘
> 다 v2 후보.

---

## 자동 스모크 (`pnpm verify` / `pnpm inspect`)

두 스크립트가 실행 중인 `pnpm dev`에 대해 스모크 흐름을 래핑합니다. 두 번째
터미널에서 실행하세요.

### `pnpm verify` — 자동 3-시나리오 스모크

```bash
# 터미널 1
pnpm dev

# 터미널 2
pnpm verify
```

JSON-RPC를 `/api/mcp`에 직접 보내고 **C1, C2, C5** — 클라이언트에서 단언
가능한 세 시나리오 — 의 PASS/FAIL 보고. PR에 그대로 붙여넣을 수 있는
evidence-record 블록 출력. 1회당 ~$0.0001 (`gpt-4o-mini` 한 번 호출).

입력 (env-only — `verify.mjs`는 플래그를 파싱하지 않음):

| env | 기본값 | 용도 |
|---|---|---|
| `MCP_URL`      | `http://localhost:8787/api/mcp` | 엔드포인트 (Hono `AI_RELAY_PORT` 기본값과 일치) |

C2 happy-path 호출에 사용되는 모델은 실행 중인 서버의 `AI_RELAY_MODEL` 값
그대로입니다 (호출자 스키마는 `{ messages }` 뿐).

`AI_RELAY_AUTH_TOKEN`은 `.env.local`에서 읽음.

C4(서버 측 sampling 오버라이드)와 C6(취소)는 클라이언트에서 단언할 수 없음
— 이 둘은 아래 수동 5-시나리오로 fall through. Production 측 재검증(§E)도
수동: 이 스크립트는 로컬 전용.

### `pnpm inspect` — 단발 호출

`npx @modelcontextprotocol/inspector --cli`를 래핑하여 Inspector UI 없이
도구 호출 1회를 수행. 프롬프트 반복 작업이나 비-기본 엔드포인트/모델/도구를
가리킬 때 유용.

```bash
pnpm inspect                                  # tools/call → chat-completions ("ping")
pnpm inspect --method=tools/list              # 등록된 도구만
pnpm inspect --message="안녕"                 # 사용자 메시지 커스텀
pnpm inspect --url=http://localhost:8788/api/mcp
pnpm inspect --tool=other_tool --message="..."
```

플래그 (우선순위: `--flag=` > `process.env` > `.env.local` > 기본):

| 플래그 | env | 기본값 |
|---|---|---|
| `--url=`     | `MCP_URL`     | `http://localhost:8787/api/mcp` |
| `--token=`   | `AI_RELAY_AUTH_TOKEN` (`.env.local`에서도 읽음) | — |
| `--tool=`    | `MCP_TOOL`    | `chat-completions` |
| `--message=` | `MCP_MESSAGE` | `ping` |
| `--method=`  | —             | `tools/call` (또는 `tools/list`) |

`--model=` 은 받지 않습니다 — 모델은 서버 측 구성 (Hono 서버의
`AI_RELAY_MODEL` env, stdio bin의 `-m` 플래그) 입니다. 이 스크립트가
구성하는 tools/call 인자는 `{ messages }` 만 보냅니다.

---

## 수동 절차

`pnpm verify`는 클라이언트에서 단언 가능한 부분(C1, C2, C5)만 커버합니다.
C4(클램프), C6(취소), production 재검증을 위해서는 아래 수동 절차로 fall
through (섹션 A–E).

**팁 — verbose 추적.** 시나리오가 실패하거나, 파싱된 플래그/환경 스냅샷/
OpenAI 요청/JSON-RPC 트래픽을 들여다봐야 할 때는 bin에 `-v` / `--verbose`를
넘기거나 `AI_RELAY_VERBOSE=1`을 설정하세요. 추적은 **stderr**로 출력되므로
Inspector가 읽는 stdout JSON-RPC 채널은 깨끗하게 유지됩니다.

```bash
ai-relay openai chat-completions -v -m gpt-4o-mini "ping"

AI_RELAY_VERBOSE=1 npx @modelcontextprotocol/inspector --cli \
  node packages/ai-relay/dist/bin/ai-relay.js openai -m gpt-4o-mini \
  --method tools/list
```

시크릿(`AI_RELAY_API_KEY`, `--api-key` 값)은 `***redacted(Nchars)***`로만
표시되며, OpenAI / MCP 응답 본문은 문자 수 + finish reason 메타데이터로만
요약됩니다. 응답 본문 자체가 stderr에 출력되는 일은 없습니다.

## A. 준비

1. `.env.local`에 **개인 dev OpenAI 키**(production 키 아님)와 원하는
   `AI_RELAY_AUTH_TOKEN`(32바이트 이상), 그리고 업스트림 모델 채우기:
   ```bash
   AI_RELAY_API_KEY=sk-...
   AI_RELAY_AUTH_TOKEN=$(openssl rand -hex 32)
   AI_RELAY_MODEL=gpt-4o-mini
   ```
   `.env.local`은 gitignore — 값은 절대 커밋 금지.

2. 개발 서버 시작:
   ```bash
   pnpm dev
   ```
   서버는 `http://localhost:8787` (Hono, `AI_RELAY_PORT` 기본값과 일치)에서
   listening. MCP 엔드포인트는 `http://localhost:8787/api/mcp`.

3. **워밍업**:
   ```bash
   curl -i "http://localhost:8787/api/mcp" \
     -H "Authorization: Bearer $AI_RELAY_AUTH_TOKEN" \
     -X GET
   ```
   HTTP 4xx 기대 (mcp-handler가 bare GET에 응답). 5xx만 아니면 함수가
   도달했다는 증거.

---

## B. Inspector 연결

1. 별도 터미널에서 Inspector 시작:
   ```bash
   npx @modelcontextprotocol/inspector
   ```
   Inspector가 stdout에 **Proxy Session Token**을 출력 — 이 터미널을 띄워
   놓을 것.

2. 브라우저가 자동 열림. Inspector UI에서:
   - **Transport**: Streamable HTTP
   - **URL**: `http://localhost:8787/api/mcp`
   - **Header**: `Authorization: Bearer <AI_RELAY_AUTH_TOKEN>` (`.env.local`의
     값을 붙여넣기)
   - **Proxy Session Token**: Inspector 터미널의 토큰을 붙여넣기
     (`CLAUDE.md` §9 — frequently forgotten)

3. **Connect** 클릭. 연결 성공과 **Tools** 탭에 도구 1개
   `chat-completions`이 보이기를 기대.

---

## C. 검증 시나리오

PR 머지 전에 모두 PASS여야 합니다. C7은 릴레이가 둘 이상의 업스트림을
등록한 경우에만 해당합니다 (v1 기본 릴레이는 단일 `chat-completions`만
등록하므로, C7은 SDK의 `multi-registration` 예제 또는 다중 업스트림을
한 서버에 등록한 컨슈머에서 검증).

| # | 시나리오 | 단계 | 기대 결과 |
|---|---|---|---|
| **C1** | 도구 목록 | Inspector에서 **Tools** 탭으로 전환 | `chat-completions` 1개가 표시. 입력 스키마는 `{ messages: Array<{role, content}> }` 뿐 (`model` / `temperature` / `max_tokens` / `top_p` / `stop` 필드 없음) — `.strict()`. |
| **C2** | Happy path | `chat-completions`에서 **Run Tool** 클릭. 입력: `messages: [{role: "user", content: "ping"}]` (받는 필드는 이것뿐). | 응답이 `result.content[0].text`에 누적 텍스트 포함. `result.structuredContent.model` 이 서버의 `AI_RELAY_MODEL` 과 일치. `result.structuredContent.usage.total_tokens > 0`. `result.isError`는 `false`. |
| **C4** | 서버 측 sampling 오버라이드 | dev 서버를 **중지**. `AI_RELAY_MAX_TOKENS=64 AI_RELAY_TEMPERATURE=0.1 pnpm dev` 로 재시작. C2 재실행. | 응답 성공. 서버 stderr verbose 로그 (`pnpm dev -v` 또는 `AI_RELAY_VERBOSE=1`) 의 `openai-request` 페이로드에 `max_tokens: 64`, `temperature: 0.1` 표시. 호출자는 이 필드들을 보내지 않았음. |
| **C5** | Bearer 거부 | Inspector에서 **Disconnect**, Header를 `Authorization: Bearer wrong-token`으로 변경, **Connect** | HTTP 401 + `WWW-Authenticate: Bearer` 헤더로 연결 실패. 올바른 토큰으로 재연결해 계속 진행. |
| **C6** | 취소 (수동) | C2를 긴 프롬프트(예: "Write a 500-word essay about sourdough")로 실행. 스트림 도중 Inspector에서 **Disconnect** | 서버 로그에 SDK 호출 abort 표시; OpenAI usage 페이지(~1분 뒤 새로고침)에 전체 출력 비용이 안 보임. (시각적 확인이 부정확 — 수동 관찰만.) |
| **C7** | 다중 등록 *(SDK 컨슈머 전용)* | 서버가 `registerOpenAIChat`을 두 이름(예: `chat-completions` + `azure_chat`, 서로 다른 `apiKey` + `baseURL` + `model`)으로 등록한 경우. **Tools** 탭을 열고 각각을 `{ messages: [...] }` 로 실행. | `tools/list`에 두 entry 모두 표시. 각 `tools/call`이 자기 업스트림에서 자기 캡처된 `model` 로 응답 (각 응답의 `structuredContent.model` 로 확인). |

---

## D. 증거 기록

절차 완료 후 PR 감사 추적용으로 결과를 기록. 컨벤션은
`$STATE_DIR/manual-mcp-inspector.log`에 작성 (또는 동등한 텍스트를 PR
댓글에 첨부).

**템플릿**:

```
MCP Inspector verification — <YYYY-MM-DD HH:MM TZ>
Verifier:  <이름 / 핸들>
Branch:    <브랜치 이름>
Commit:    <git rev-parse --short HEAD>
Endpoint:  http://localhost:8787/api/mcp  (또는 production URL — doc/DEPLOY.ko.md §3 참고)
Model:     <서버가 사용한 AI_RELAY_MODEL 값>

C1 tools/list (messages-only 스키마) — PASS / FAIL  <한줄 메모>
C2 chat-completions happy path       — PASS / FAIL  usage: {prompt_tokens: N, completion_tokens: N, total_tokens: N}
C4 서버 측 sampling 오버라이드       — PASS / FAIL  <한줄 메모>
C5 wrong bearer 401                  — PASS / FAIL  <한줄 메모>
C6 cancellation                      — PASS / FAIL  <한줄 메모>

Notes:
- <플래그할 만한 이상사항>
```

시나리오가 실패하면, PR에 첨부하기 전에 응답 발췌에서 비밀 마스킹
(`AI_RELAY_API_KEY`, `AI_RELAY_AUTH_TOKEN`, 전체 프롬프트 본문 — 메타데이터만,
`CLAUDE.md` §4에 따라).

---

## E. Production 배포 후

[`doc/DEPLOY.ko.md` §3.5 검증 체크리스트](./DEPLOY.ko.md#35-검증-체크리스트)
실행 후, **C1, C2, C5**를 production URL
(`https://<project>.vercel.app/api/mcp`)에 대해 **production**
`AI_RELAY_AUTH_TOKEN`과 prod에 발급된 `AI_RELAY_API_KEY`로 재실행.

C4와 C6은 로컬 전용 (sampling 오버라이드는 다른 env 변수로 서버를 재시작해야
하고, 취소 관찰은 production에서 확인하기 어려움).

---

## F. 비-목표

- **자동 Inspector 시나리오** (Inspector를 spawning하는 Playwright) — v2
  후보; v1은 수동 루프 유지 — Inspector 자체가 디버깅 UI이지 CI surface가
  아님.
- **주기적 production health check** (cron / 모니터링) — v2 후보
  (observability의 일부 — [`ARCHITECTURE.ko.md` §11](./ARCHITECTURE.ko.md#11-v2-백로그)
  참고).
- **호출 단위 사용량 단언** — Inspector는 호출별 `usage`를 보여주지만 절차
  자체는 특정 토큰 카운트를 강제하지 않음 (모델 동작이 가변).

---

## 참고

- [`ARCHITECTURE.ko.md` §10](./ARCHITECTURE.ko.md#10-테스트-전략-v1) — 테스트 전략 (수동 E2E 레이어)
- [`CLAUDE.md` §3](../CLAUDE.md#3-verify-commands) — 증거 정책 (`evidence-mode: none`)
- [`CLAUDE.md` §7](../CLAUDE.md#7-testing--what-goes-where) — 테스트 매트릭스 (마지막 행이 이 절차)
- [`CLAUDE.md` §9](../CLAUDE.md#9-frequently-forgotten-items) — Proxy Session Token
- [`doc/DEPLOY.ko.md` §3](./DEPLOY.ko.md#3-docker-canonical) — Docker 배포 (canonical; §3.5에서 이 절차 참조)
- [`doc/DEPLOY.ko.md` §4](./DEPLOY.ko.md#4-vercel-커뮤니티-지원) — Vercel 배포 (커뮤니티 지원)
