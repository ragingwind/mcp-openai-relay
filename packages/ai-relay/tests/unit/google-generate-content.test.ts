// Unit tests for `src/google/generate-content.ts` — the framework-agnostic
// Google Gemini Generate-Content registrar. Tests target
// `makeGoogleGenerateContentHandler` with MSW intercepting the
// generativelanguage.googleapis.com boundary. Each test creates its own
// handler so there is no module-level shared state to reset.

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type GoogleGenerateContentConfig,
  type GoogleGenerateContentHandlerBundle,
  type GoogleGenerateContentResult,
  makeGoogleGenerateContentHandler,
} from "../../src/google/generate-content.js";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const VALID_MODEL = "gemini-2.0-flash";
// Streaming endpoint matched by the SDK (URL contains the model id).
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${VALID_MODEL}:streamGenerateContent`;

const TEST_API_KEY = "test-google-api-key";

const VALID_MESSAGES = [{ role: "user" as const, content: "say hi" }];

function makeHandler(
  overrides: Partial<GoogleGenerateContentConfig> = {},
): GoogleGenerateContentHandlerBundle {
  return makeGoogleGenerateContentHandler({
    apiKey: TEST_API_KEY,
    model: VALID_MODEL,
    ...overrides,
  });
}

// Build an SSE stream of Gemini chunks. The SDK accepts `alt=sse` and parses
// each `data: { ... }` line as one `GenerateContentResponse`.
function sseStream(chunks: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunks[i])}\r\n\r\n`));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

function sseResponse(chunks: unknown[]) {
  return new HttpResponse(sseStream(chunks), {
    headers: { "content-type": "text/event-stream" },
  });
}

function textChunk(text: string, opts: { finishReason?: string; usage?: unknown } = {}) {
  const chunk: Record<string, unknown> = {
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        ...(opts.finishReason ? { finishReason: opts.finishReason } : {}),
      },
    ],
  };
  if (opts.usage) chunk.usageMetadata = opts.usage;
  return chunk;
}

function defaultOkStream(text = "ok"): unknown[] {
  return [
    textChunk(text, {
      finishReason: "STOP",
      usage: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
    }),
  ];
}

function assertNoSecretLeak(result: GoogleGenerateContentResult | unknown): void {
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(TEST_API_KEY);
}

// =========================================================================
// A: Input Validation (S1)
// =========================================================================

describe("google generate-content — input validation", () => {
  it("P1: accepts a minimal { messages } input", async () => {
    server.use(http.post(ENDPOINT, () => sseResponse(defaultOkStream())));
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(false);
  });

  it("D1: rejects unknown extra keys (strict schema)", async () => {
    const { handler } = makeHandler();
    await expect(handler({ messages: VALID_MESSAGES, unknown: "x" })).rejects.toThrow();
  });

  it("D2: rejects role enum value outside {system,user,assistant}", async () => {
    const { handler } = makeHandler();
    await expect(
      handler({ messages: [{ role: "tool", content: "x" }] as unknown }),
    ).rejects.toThrow();
  });

  it("D3: rejects empty messages array (min 1)", async () => {
    const { handler } = makeHandler();
    await expect(handler({ messages: [] })).rejects.toThrow();
  });
});

// =========================================================================
// B: System instruction extraction (S2)
// =========================================================================

describe("google generate-content — system instruction extraction", () => {
  it("P1: leading single system message → systemInstruction.parts[0].text", async () => {
    let body: { systemInstruction?: { parts?: Array<{ text?: string }> } } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler();
    await handler({
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
    });
    expect(body?.systemInstruction?.parts?.[0]?.text).toBe("be terse");
  });

  it("P2: multiple leading system messages joined with \\n\\n", async () => {
    let body: { systemInstruction?: { parts?: Array<{ text?: string }> } } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler();
    await handler({
      messages: [
        { role: "system", content: "A" },
        { role: "system", content: "B" },
        { role: "user", content: "hi" },
      ],
    });
    expect(body?.systemInstruction?.parts?.[0]?.text).toBe("A\n\nB");
  });

  it("P3: no system messages → request body omits systemInstruction", async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler();
    await handler({ messages: VALID_MESSAGES });
    expect(body).toBeDefined();
    expect("systemInstruction" in (body ?? {})).toBe(false);
  });

  it("D1: non-leading system message → isError with code bad_request", async () => {
    const { handler } = makeHandler();
    const result = await handler({
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "interleaved" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("bad_request");
    expect(result.content[0]?.text).toMatch(/interleaved|system/i);
  });
});

// =========================================================================
// C: Role translation (S3) — assistant → model in contents[]
// =========================================================================

describe("google generate-content — role translation", () => {
  it("P1: assistant → model in contents[]", async () => {
    let body: { contents?: Array<{ role?: string; parts?: Array<{ text?: string }> }> } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler();
    await handler({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "again" },
      ],
    });
    expect(body?.contents?.map((c) => c.role)).toEqual(["user", "model", "user"]);
  });

  it("P2: user role passed through unchanged in contents[]", async () => {
    let body: { contents?: Array<{ role?: string }> } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler();
    await handler({ messages: VALID_MESSAGES });
    expect(body?.contents?.[0]?.role).toBe("user");
  });
});

// =========================================================================
// D: Consecutive same-role merging (S4)
// =========================================================================

describe("google generate-content — consecutive same-role merging", () => {
  it("P1: consecutive user messages merged into one Content with multiple parts", async () => {
    let body: { contents?: Array<{ role?: string; parts?: Array<{ text?: string }> }> } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler();
    await handler({
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ],
    });
    expect(body?.contents).toHaveLength(1);
    expect(body?.contents?.[0]?.role).toBe("user");
    expect(body?.contents?.[0]?.parts?.map((p) => p.text)).toEqual(["first", "second"]);
  });

  it("P2: consecutive assistant messages merged (after assistant→model translation)", async () => {
    let body: { contents?: Array<{ role?: string; parts?: Array<{ text?: string }> }> } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler();
    await handler({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "k" },
      ],
    });
    expect(body?.contents).toHaveLength(3);
    expect(body?.contents?.[1]?.role).toBe("model");
    expect(body?.contents?.[1]?.parts?.map((p) => p.text)).toEqual(["a", "b"]);
  });

  it("N1: alternating roles produce one Content per message", async () => {
    let body: { contents?: Array<{ role?: string; parts?: Array<{ text?: string }> }> } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler();
    await handler({
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "m1" },
        { role: "user", content: "u2" },
      ],
    });
    expect(body?.contents).toHaveLength(3);
  });
});

// =========================================================================
// E: Stream accumulation + usage (S5)
// =========================================================================

describe("google generate-content — stream accumulation", () => {
  it("P1: multi-chunk text concatenated into accumulated text", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        sseResponse([
          textChunk("Hello"),
          textChunk(" "),
          textChunk("world", {
            finishReason: "STOP",
            usage: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
          }),
        ]),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe("Hello world");
    expect(result.structuredContent.model).toBe(VALID_MODEL);
    assertNoSecretLeak(result);
  });

  it("P2: usageMetadata mapped to prompt/completion/total_tokens", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        sseResponse([
          textChunk("x", {
            finishReason: "STOP",
            usage: { promptTokenCount: 7, candidatesTokenCount: 5, totalTokenCount: 12 },
          }),
        ]),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.structuredContent.usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 5,
      total_tokens: 12,
    });
  });

  it("N1: chunk with missing text part contributes empty string", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        sseResponse([
          { candidates: [{ content: { role: "model", parts: [] } }] },
          textChunk("visible", { finishReason: "STOP" }),
        ]),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.content[0]?.text).toBe("visible");
  });
});

// =========================================================================
// F: Finish reason mapping (S6, S7)
// =========================================================================

describe("google generate-content — finishReason mapping", () => {
  it("P1: STOP → finish_reason 'stop'", async () => {
    server.use(http.post(ENDPOINT, () => sseResponse([textChunk("x", { finishReason: "STOP" })])));
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.structuredContent.finish_reason).toBe("stop");
    expect(result.isError).toBe(false);
  });

  it("P2: MAX_TOKENS → finish_reason 'length'", async () => {
    server.use(
      http.post(ENDPOINT, () => sseResponse([textChunk("x", { finishReason: "MAX_TOKENS" })])),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.structuredContent.finish_reason).toBe("length");
  });

  it("P3: SAFETY → isError content_policy", async () => {
    server.use(http.post(ENDPOINT, () => sseResponse([textChunk("", { finishReason: "SAFETY" })])));
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("content_policy");
  });

  it("P4: RECITATION → isError content_policy", async () => {
    server.use(
      http.post(ENDPOINT, () => sseResponse([textChunk("", { finishReason: "RECITATION" })])),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("content_policy");
  });

  it("P5: other reasons pass through lowercased", async () => {
    server.use(http.post(ENDPOINT, () => sseResponse([textChunk("x", { finishReason: "OTHER" })])));
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.structuredContent.finish_reason).toBe("other");
  });
});

// =========================================================================
// G: Error Mapping (S8)
// =========================================================================

describe("google generate-content — error mapping", () => {
  it("D1: 401 → code 'auth'", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () =>
          new HttpResponse(JSON.stringify({ error: { message: "bad key", code: 401 } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("auth");
    assertNoSecretLeak(result);
  });

  it("D2: 403 → code 'auth'", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () =>
          new HttpResponse(JSON.stringify({ error: { message: "forbidden", code: 403 } }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.structuredContent.code).toBe("auth");
  });

  it("D3: 429 → 'rate_limited'", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () =>
          new HttpResponse(JSON.stringify({ error: { message: "rate", code: 429 } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.structuredContent.code).toBe("rate_limited");
  });

  it("D4: 400 INVALID_ARGUMENT containing 'context' → context_length", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () =>
          new HttpResponse(
            JSON.stringify({
              error: {
                message: "The input context is too long for the model.",
                code: 400,
                status: "INVALID_ARGUMENT",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.structuredContent.code).toBe("context_length");
  });

  it("D5: 400 without 'context' → bad_request", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () =>
          new HttpResponse(
            JSON.stringify({
              error: { message: "malformed payload", code: 400, status: "INVALID_ARGUMENT" },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.structuredContent.code).toBe("bad_request");
  });

  it("D6: 500 → upstream_error", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () =>
          new HttpResponse(JSON.stringify({ error: { message: "boom", code: 500 } }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.structuredContent.code).toBe("upstream_error");
  });

  it("D7: network error → upstream_error", async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.error()));
    const { handler } = makeHandler();
    const result = await handler({ messages: VALID_MESSAGES });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("upstream_error");
  });
});

// =========================================================================
// H: Cancellation (S9)
// =========================================================================

describe("google generate-content — cancellation", () => {
  it("D1: abort mid-stream → isError upstream_error", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () =>
          new HttpResponse(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const enc = new TextEncoder();
                controller.enqueue(
                  enc.encode(`data: ${JSON.stringify(textChunk("partial"))}\r\n\r\n`),
                );
                // intentionally never closes
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    );
    const { handler } = makeHandler();
    const ac = new AbortController();
    const promise = handler({ messages: VALID_MESSAGES }, { signal: ac.signal });
    await Promise.resolve();
    ac.abort();
    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("upstream_error");
  });
});

// =========================================================================
// I: Sampling params forwarding (S10)
// =========================================================================

describe("google generate-content — sampling params forwarding", () => {
  it("P1: temperature forwarded under generationConfig", async () => {
    let body: { generationConfig?: Record<string, unknown> } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler({ temperature: 0.4 });
    await handler({ messages: VALID_MESSAGES });
    expect(body?.generationConfig?.temperature).toBe(0.4);
  });

  it("P2: top_p forwarded as topP under generationConfig", async () => {
    let body: { generationConfig?: Record<string, unknown> } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler({ top_p: 0.9 });
    await handler({ messages: VALID_MESSAGES });
    expect(body?.generationConfig?.topP).toBe(0.9);
  });

  it("P3: max_tokens forwarded as maxOutputTokens under generationConfig", async () => {
    let body: { generationConfig?: Record<string, unknown> } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler({ max_tokens: 256 });
    await handler({ messages: VALID_MESSAGES });
    expect(body?.generationConfig?.maxOutputTokens).toBe(256);
  });

  it("P4: undefined params omitted from generationConfig", async () => {
    let body: { generationConfig?: Record<string, unknown> } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler();
    await handler({ messages: VALID_MESSAGES });
    const gc = body?.generationConfig ?? {};
    expect("temperature" in gc).toBe(false);
    expect("topP" in gc).toBe(false);
    expect("maxOutputTokens" in gc).toBe(false);
  });
});

// =========================================================================
// J: Stop coercion (S11)
// =========================================================================

describe("google generate-content — stop coercion to stopSequences", () => {
  it("P1: stop string 'END' → stopSequences: ['END']", async () => {
    let body: { generationConfig?: { stopSequences?: unknown } } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler({ stop: "END" });
    await handler({ messages: VALID_MESSAGES });
    expect(body?.generationConfig?.stopSequences).toEqual(["END"]);
  });

  it("P2: comma-separated string 'A,B' → stopSequences: ['A','B']", async () => {
    let body: { generationConfig?: { stopSequences?: unknown } } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler({ stop: "A,B" });
    await handler({ messages: VALID_MESSAGES });
    expect(body?.generationConfig?.stopSequences).toEqual(["A", "B"]);
  });

  it("P3: array passed through verbatim", async () => {
    let body: { generationConfig?: { stopSequences?: unknown } } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler({ stop: ["X", "Y"] });
    await handler({ messages: VALID_MESSAGES });
    expect(body?.generationConfig?.stopSequences).toEqual(["X", "Y"]);
  });

  it("N1: undefined stop → stopSequences omitted", async () => {
    let body: { generationConfig?: Record<string, unknown> } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseResponse(defaultOkStream());
      }),
    );
    const { handler } = makeHandler();
    await handler({ messages: VALID_MESSAGES });
    expect("stopSequences" in (body?.generationConfig ?? {})).toBe(false);
  });
});
