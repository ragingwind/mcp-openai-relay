// Unit tests for `src/openai/responses.ts` — the OpenAI Responses tool.
//
// Tests target `makeOpenAIResponsesHandler(config)` directly: the same factory
// `registerOpenAIResponses` calls internally. Each test creates its own handler
// so there is no module-level shared state to reset.
//
// The Responses API differs from Chat Completions in three observable ways:
//   - endpoint: `/v1/responses` (not `/v1/chat/completions`)
//   - input shape: `input` of `{ role, content: [{ type: 'input_text', text }] }`
//     (not `messages`)
//   - stream payload: named SSE events (`response.output_text.delta`,
//     `response.reasoning_summary_text.delta`, `response.completed`) carrying
//     `delta` strings and a final `response.usage` + `response.status`.

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  makeOpenAIResponsesHandler,
  type OpenAIResponsesConfig,
  type OpenAIResponsesHandlerBundle,
  type OpenAIResponsesResult,
} from "../../src/openai/responses.js";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ENDPOINT = "https://api.openai.com/v1/responses";

const TEST_API_KEY = "test-openai-api-key";

const VALID_MODEL = "gpt-4o-mini";
const VALID_MESSAGES = [{ role: "user" as const, content: "say hi" }];

function makeHandler(overrides: Partial<OpenAIResponsesConfig> = {}): OpenAIResponsesHandlerBundle {
  return makeOpenAIResponsesHandler({
    apiKey: TEST_API_KEY,
    model: VALID_MODEL,
    ...overrides,
  });
}

/**
 * Build a Responses-API SSE body. The Responses API uses named SSE events
 * (`event: response.output_text.delta\ndata: ...\n\n`) — unlike Chat
 * Completions which emits unnamed `data: ...\n\n` chunks.
 */
function responsesSSEStream(opts: {
  text?: string;
  reasoning?: string;
  usage?: { input_tokens: number; output_tokens: number; total_tokens?: number };
  status?: string;
  emitCompleted?: boolean;
}): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const parts: string[] = [];
  if (opts.text !== undefined && opts.text.length > 0) {
    parts.push(
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: opts.text,
      })}\n\n`,
    );
  }
  if (opts.reasoning !== undefined && opts.reasoning.length > 0) {
    parts.push(
      `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({
        type: "response.reasoning_summary_text.delta",
        delta: opts.reasoning,
      })}\n\n`,
    );
  }
  if (opts.emitCompleted !== false) {
    const responsePayload: Record<string, unknown> = {
      status: opts.status ?? "completed",
    };
    if (opts.usage) responsePayload.usage = opts.usage;
    parts.push(
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: responsePayload,
      })}\n\n`,
    );
  }
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < parts.length) {
        c.enqueue(enc.encode(parts[i++]));
      } else {
        c.close();
      }
    },
  });
}

function responsesSSEResponse(opts: Parameters<typeof responsesSSEStream>[0]) {
  return new HttpResponse(responsesSSEStream(opts), {
    headers: { "content-type": "text/event-stream" },
  });
}

function assertNoSecretLeak(result: OpenAIResponsesResult | unknown): void {
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(TEST_API_KEY);
}

// =========================================================================
// A: Input Validation — caller schema is { messages } only
// =========================================================================

describe("openai responses — input validation (caller schema = messages only)", () => {
  it("P1: accepts a minimal { messages } input", async () => {
    server.use(http.post(ENDPOINT, () => responsesSSEResponse({ text: "ok" })));
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(false);
  });

  it("D1: rejects when `messages` is missing", async () => {
    const { handler } = makeHandler();
    await expect(handler({})).rejects.toThrow();
  });

  it("D2: rejects when `messages` is empty", async () => {
    const { handler } = makeHandler();
    await expect(handler({ messages: [] })).rejects.toThrow();
  });

  it("D3: rejects caller-supplied `model` (strict schema)", async () => {
    const { handler } = makeHandler();
    await expect(handler({ model: "override", messages: VALID_MESSAGES })).rejects.toThrow();
  });

  it("D4: rejects unknown extra keys", async () => {
    const { handler } = makeHandler();
    await expect(handler({ messages: VALID_MESSAGES, unknown: "x" })).rejects.toThrow();
  });
});

// =========================================================================
// B: Streaming accumulation, usage, finish_reason (status), reasoning
// =========================================================================

describe("openai responses — streaming accumulation + usage + reasoning", () => {
  it("P1: accumulates response.output_text.delta + captures usage + status", async () => {
    server.use(
      http.post(ENDPOINT, () => {
        // Multi-chunk: two text deltas + completed with usage.
        const enc = new TextEncoder();
        return new HttpResponse(
          new ReadableStream({
            start(c) {
              c.enqueue(
                enc.encode(
                  `event: response.output_text.delta\ndata: ${JSON.stringify({
                    type: "response.output_text.delta",
                    delta: "Hello ",
                  })}\n\n`,
                ),
              );
              c.enqueue(
                enc.encode(
                  `event: response.output_text.delta\ndata: ${JSON.stringify({
                    type: "response.output_text.delta",
                    delta: "world",
                  })}\n\n`,
                ),
              );
              c.enqueue(
                enc.encode(
                  `event: response.completed\ndata: ${JSON.stringify({
                    type: "response.completed",
                    response: {
                      status: "completed",
                      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
                    },
                  })}\n\n`,
                ),
              );
              c.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe("Hello world");
    expect(result.structuredContent.usage).toEqual({
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
    });
    expect(result.structuredContent.finish_reason).toBe("completed");
    expect(result.structuredContent.model).toBe(VALID_MODEL);
    assertNoSecretLeak(result);
  });

  it("P1: accumulates reasoning_summary_text.delta into structuredContent.reasoning", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        responsesSSEResponse({
          text: "answer",
          reasoning: "thinking step",
          usage: { input_tokens: 1, output_tokens: 1 },
          status: "completed",
        }),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe("answer");
    expect(result.structuredContent.reasoning).toBe("thinking step");
    assertNoSecretLeak(result);
  });

  it("N1: omits `reasoning` key when no reasoning_summary_text.delta arrived", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        responsesSSEResponse({
          text: "answer",
          usage: { input_tokens: 1, output_tokens: 1 },
          status: "completed",
        }),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.reasoning).toBeUndefined();
    expect("reasoning" in result.structuredContent).toBe(false);
  });

  it("P1: messages are translated to Responses `input` shape (role + input_text content)", async () => {
    let body: { input?: unknown; messages?: unknown; model?: string } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return responsesSSEResponse({ text: "ok" });
      }),
    );
    const { handler } = makeHandler();
    await handler({
      messages: [
        { role: "system", content: "you are nice" },
        { role: "user", content: "hi" },
      ],
    });
    expect(body?.messages).toBeUndefined();
    expect(body?.input).toEqual([
      { role: "system", content: [{ type: "input_text", text: "you are nice" }] },
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
    expect(body?.model).toBe(VALID_MODEL);
  });

  it("N1: max_output_tokens is forwarded from config.max_tokens", async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return responsesSSEResponse({ text: "ok" });
      }),
    );
    const { handler } = makeHandler({ max_tokens: 256 });
    await handler({ messages: VALID_MESSAGES });
    expect(body?.max_output_tokens).toBe(256);
    expect("max_tokens" in (body ?? {})).toBe(false);
  });

  it("D1: streaming call performs exactly one upstream request on 5xx (maxRetries: 0)", async () => {
    let callCount = 0;
    server.use(
      http.post(ENDPOINT, () => {
        callCount++;
        return new HttpResponse("upstream blew up", { status: 500 });
      }),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("upstream_error");
    expect(callCount).toBe(1);
  });
});

// =========================================================================
// C: Error Mapping (reuses chat.ts mapOpenAIError)
// =========================================================================

describe("openai responses — error mapping", () => {
  it("D1: maps upstream 401 to code: 'auth'", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () => new HttpResponse(JSON.stringify({ error: { message: "no key" } }), { status: 401 }),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("auth");
    expect(result.content[0]?.text).toBe("Authentication failed");
    assertNoSecretLeak(result);
  });

  it("D1: maps upstream 429 to code: 'rate_limited' with retryAfter from header", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () =>
          new HttpResponse(JSON.stringify({ error: { message: "slow down" } }), {
            status: 429,
            headers: { "retry-after": "30" },
          }),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("rate_limited");
    expect(result.structuredContent.retryAfter).toBe(30);
  });

  it("D1: maps 400 context_length_exceeded to code: 'context_length'", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () =>
          new HttpResponse(
            JSON.stringify({
              error: { code: "context_length_exceeded", message: "too many tokens" },
            }),
            { status: 400 },
          ),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("context_length");
  });

  it("D1: maps 500 to code: 'upstream_error' and surfaces redacted body", async () => {
    const body = `{"detail":"leak ${TEST_API_KEY} end"}`;
    server.use(http.post(ENDPOINT, () => new HttpResponse(body, { status: 500 })));
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("upstream_error");
    expect(result.content[0]?.text).toContain("[REDACTED]");
    assertNoSecretLeak(result);
  });

  it("D1: short-circuits when extra.signal is already aborted", async () => {
    server.use(http.post(ENDPOINT, () => responsesSSEResponse({ text: "x" })));
    const { handler } = makeHandler();
    const ac = new AbortController();
    ac.abort();
    const result = await handler({ messages: VALID_MESSAGES }, { signal: ac.signal });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("upstream_error");
    assertNoSecretLeak(result);
  });
});

// =========================================================================
// D: Config options — temperature, top_p, reasoning_effort, descriptor
// =========================================================================

describe("openai responses — config-driven upstream parameters", () => {
  it("P2: config.temperature + top_p are forwarded when set", async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return responsesSSEResponse({ text: "ok" });
      }),
    );
    const { handler } = makeHandler({ temperature: 0.7, top_p: 0.9 });
    await handler({ messages: VALID_MESSAGES });
    expect(body?.temperature).toBe(0.7);
    expect(body?.top_p).toBe(0.9);
  });

  it("P2: config.reasoning_effort is forwarded as reasoning.effort", async () => {
    let body: { reasoning?: { effort?: string } } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return responsesSSEResponse({ text: "ok" });
      }),
    );
    const { handler } = makeHandler({ reasoning_effort: "high" });
    await handler({ messages: VALID_MESSAGES });
    expect(body?.reasoning?.effort).toBe("high");
  });

  it("N1: reasoning is omitted from upstream call when reasoning_effort unset", async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return responsesSSEResponse({ text: "ok" });
      }),
    );
    const { handler } = makeHandler();
    await handler({ messages: VALID_MESSAGES });
    expect("reasoning" in (body ?? {})).toBe(false);
  });

  it("D1: makeOpenAIResponsesHandler throws when config.model is missing", () => {
    // @ts-expect-error - intentional missing required field
    expect(() => makeOpenAIResponsesHandler({ apiKey: TEST_API_KEY })).toThrow(/model/i);
  });

  it("P2: bundle name defaults to 'responses' and description advertises reasoning_effort", () => {
    const bundle = makeHandler({ reasoning_effort: "medium" });
    expect(bundle.name).toBe("responses");
    expect(bundle.description).toContain("reasoning_effort: medium");
    expect(bundle.description).toContain(`model: ${VALID_MODEL}`);
  });
});
