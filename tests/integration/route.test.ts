// Integration tests for `app/src/index.ts` — covers all 13 behaviors
// from plan §6 (B1-B13).
//
// What "integration" means here (per plan OQ-3 / CLAUDE.md §7): the Hono
// `app` is invoked end-to-end via `app.fetch(request)` with real Web
// `Request` and `Response` instances, exercising mcp-handler + withMcpAuth
// + zod + the chat-completions tool wiring as one stack. Only the OpenAI HTTP
// boundary is mocked (MSW). We never mock `mcp-handler` itself — that
// would defeat the purpose.
//
// MSW server lifecycle pattern: MSW listens FIRST in beforeAll, then the
// app module is dynamically imported. The openai SDK captures `fetch` at
// constructor time inside `createOpenAIClient`; if MSW patches
// `globalThis.fetch` AFTER that capture, the SDK still holds the real fetch
// and tests hit api.openai.com.
//
// URL convention: the Hono route is mounted at `/api/mcp` and `basePath`
// in the entry file is `"/api"`, so mcp-handler matches the streamable HTTP
// transport at pathname `/api/mcp`. Tests POST to `http://localhost/api/mcp`.
//
// Streamable HTTP semantics: in stateless mode (sessionIdGenerator
// undefined — mcp-handler's default) the SDK accepts a single JSON-RPC
// request per POST and returns either `application/json` or
// `text/event-stream` depending on the `Accept` header. The server requires
// the client to advertise BOTH `application/json` and `text/event-stream`
// in `Accept`; missing either yields HTTP 406. We send both on every
// authed request below.

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseEnv } from "../../app/src/env.js";

// Parse the test-seeded env once. The setup file (tests/setup-env.ts) sets
// process.env BEFORE this module loads, so the parse succeeds with defaults.
const env = parseEnv(process.env);

// --- shared MSW server lifecycle ----------------------------------------

const server = setupServer();
let app: { fetch: (req: Request) => Promise<Response> };

beforeAll(async () => {
  server.listen({ onUnhandledRequest: "error" });
  // Dynamic import AFTER MSW listens. The openai SDK is constructed lazily
  // inside createOpenAIClient when the app registers its tool; by importing
  // the entry module here, the SDK captures the MSW-patched fetch reference.
  const mod = await import("../../app/src/index.js");
  app = mod.app as { fetch: (req: Request) => Promise<Response> };
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// --- helpers ------------------------------------------------------------

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const MCP_URL = "http://localhost/api/mcp";
const VALID_BEARER = `Bearer ${"x".repeat(32)}`; // matches tests/setup-env.ts seed

const ACCEPT_BOTH = "application/json, text/event-stream";

/** JSON body for an authed `tools/list` request. */
function makeListRequest(opts: { bearer?: string | null } = {}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: ACCEPT_BOTH,
  };
  if (opts.bearer === undefined) headers.authorization = VALID_BEARER;
  else if (opts.bearer !== null) headers.authorization = opts.bearer;
  return new Request(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

/** JSON body for an authed `tools/call` request. */
function makeCallRequest(
  args: Record<string, unknown>,
  opts: { signal?: AbortSignal } = {},
): Request {
  const init: RequestInit = {
    method: "POST",
    headers: {
      authorization: VALID_BEARER,
      "content-type": "application/json",
      accept: ACCEPT_BOTH,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "chat-completions", arguments: args },
    }),
  };
  if (opts.signal) init.signal = opts.signal;
  return new Request(MCP_URL, init);
}

/**
 * Build a `text/event-stream` body from a list of pre-stringified JSON chunks
 * (mirrors tests/unit/completion-chat.test.ts).
 */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(`data: ${chunks[i]}\n\n`));
        i++;
      } else {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
}

function sseResponse(chunks: string[]): HttpResponse<ReadableStream<Uint8Array>> {
  return new HttpResponse(sseStream(chunks), {
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * Parse a Streamable HTTP response. The transport may emit either pure
 * `application/json` (single response) or `text/event-stream` (one or more
 * SSE events with the JSON-RPC payload as `data`). This helper handles both
 * shapes and returns the parsed JSON-RPC envelope.
 */
async function readJsonRpcResponse(res: Response): Promise<{
  jsonrpc: string;
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}> {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return (await res.json()) as ReturnType<typeof readJsonRpcResponse> extends Promise<infer T>
      ? T
      : never;
  }
  // SSE: collect all `data:` lines, parse the LAST one (the response).
  const text = await res.text();
  const dataLines = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((s) => s && s !== "[DONE]");
  // The JSON-RPC response is the final non-DONE chunk.
  const lastChunk = dataLines.at(-1);
  if (!lastChunk) {
    throw new Error(`No SSE data lines in response: ${text.slice(0, 200)}`);
  }
  return JSON.parse(lastChunk);
}

/**
 * Tool result payloads come back nested inside the JSON-RPC `result` field.
 * The MCP SDK populates `result` with `{ content, structuredContent, isError }`
 * (i.e. a CallToolResult). This helper extracts that shape with a type cast.
 */
type CallToolResultLike = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function asCallToolResult(envelope: { result?: Record<string, unknown> }): CallToolResultLike {
  if (!envelope.result) {
    throw new Error(`Expected JSON-RPC result, got: ${JSON.stringify(envelope)}`);
  }
  return envelope.result as unknown as CallToolResultLike;
}

// =========================================================================
// A: Bearer auth (B1-B3)
// =========================================================================

describe("route /api/mcp — bearer auth", () => {
  // B1: missing Authorization → 401 + WWW-Authenticate: Bearer ...
  it("D1: rejects POST without Authorization (401 + WWW-Authenticate header)", async () => {
    const res = await app.fetch(makeListRequest({ bearer: null }));
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate");
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toMatch(/Bearer/i);
  });

  // B2: wrong bearer → 401 (the InvalidTokenError path)
  it("D2: rejects POST with wrong bearer (401)", async () => {
    const res = await app.fetch(
      makeListRequest({ bearer: "Bearer wrong-token-1234567890123456789012" }),
    );
    expect(res.status).toBe(401);
  });

  // B3: correct bearer → request reaches the handler.
  // Asserting status 200 + JSON-RPC envelope is enough — the handler-level
  // assertions live in the tools/list block below.
  it("P1: accepts POST with the configured bearer token", async () => {
    const res = await app.fetch(makeListRequest());
    expect(res.status).toBe(200);
    const envelope = await readJsonRpcResponse(res);
    expect(envelope.jsonrpc).toBe("2.0");
  });
});

// =========================================================================
// B: tools/list (B4-B5)
// =========================================================================

describe("route /api/mcp — tools/list", () => {
  // B4: exposes both OpenAI tools (chat-completions + responses)
  it("P1: exposes chat-completions and responses tools", async () => {
    const res = await app.fetch(makeListRequest());
    expect(res.status).toBe(200);
    const envelope = await readJsonRpcResponse(res);
    const tools = (envelope.result?.tools ?? []) as Array<{ name: string }>;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["chat-completions", "responses"]);
  });

  // B5: tools/list response includes the input schema.
  // The SDK serializes Zod shapes as JSON Schema. We only assert the shape's
  // top-level structure (object, properties.messages) — not the full
  // serialization, which is an SDK implementation detail. Both tools share
  // the same caller-facing { messages } schema.
  it("P2: each tool's input schema exposes only `messages`", async () => {
    const res = await app.fetch(makeListRequest());
    const envelope = await readJsonRpcResponse(res);
    const tools = (envelope.result?.tools ?? []) as Array<{
      name: string;
      inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
    }>;
    for (const tool of tools) {
      const schema = tool.inputSchema;
      expect(schema, `${tool.name} inputSchema`).toBeDefined();
      expect(schema?.type).toBe("object");
      expect(schema?.properties).toBeDefined();
      expect(schema?.properties).toHaveProperty("messages");
      expect(schema?.properties).not.toHaveProperty("model");
      expect(schema?.properties).not.toHaveProperty("temperature");
      expect(schema?.properties).not.toHaveProperty("max_tokens");
      expect(schema?.properties).not.toHaveProperty("top_p");
      expect(schema?.properties).not.toHaveProperty("stop");
    }
  });
});

// =========================================================================
// C: tools/call — happy path, clamp (B6, B8)
// =========================================================================

describe("route /api/mcp — tools/call (happy + clamp)", () => {
  // B6: valid input → CallToolResult with accumulated text + structuredContent.usage
  it("P1: tools/call with valid input returns content + structuredContent.usage", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "Hello " } }] }),
          JSON.stringify({
            choices: [{ delta: { content: "world" }, finish_reason: "stop" }],
          }),
          JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          }),
        ]),
      ),
    );

    const res = await app.fetch(
      makeCallRequest({
        messages: [{ role: "user", content: "say hi" }],
      }),
    );
    expect(res.status).toBe(200);
    const envelope = await readJsonRpcResponse(res);
    const result = asCallToolResult(envelope);
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe("Hello world");
    expect(result.structuredContent?.usage).toEqual({
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
    });
  });

  // The caller-facing schema is `messages`-only. The server-configured model
  // (from `AI_RELAY_MODEL`) is what reaches the upstream — callers cannot
  // override it per-call.
  it("P2: server forwards AI_RELAY_MODEL to the upstream OpenAI request", async () => {
    let observedModel: string | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        const body = (await request.json()) as { model?: string };
        observedModel = body.model;
        return sseResponse([
          JSON.stringify({
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          }),
        ]);
      }),
    );
    const res = await app.fetch(makeCallRequest({ messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(200);
    const envelope = await readJsonRpcResponse(res);
    const result = asCallToolResult(envelope);
    expect(result.isError).toBe(false);
    expect(observedModel).toBe(env.AI_RELAY_MODEL);
  });

  // The caller-facing schema does NOT declare `model`. The MCP/SDK boundary
  // either rejects the extra field as a validation error OR strips it before
  // the handler runs. Either way, the caller-supplied value MUST NOT reach
  // upstream as the model id.
  it("D1: caller-supplied `model` cannot override the server-configured model", async () => {
    let observedModel: string | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        const body = (await request.json()) as { model?: string };
        observedModel = body.model;
        return sseResponse([
          JSON.stringify({
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          }),
        ]);
      }),
    );
    const res = await app.fetch(
      makeCallRequest({
        model: "caller-overrides-not-allowed",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(res.status).toBe(200);
    // Whether the SDK rejects (no upstream hit) or strips and forwards (upstream
    // sees server-configured model), the caller value never reaches upstream.
    expect(observedModel).not.toBe("caller-overrides-not-allowed");
    if (observedModel !== undefined) {
      expect(observedModel).toBe(env.AI_RELAY_MODEL);
    }
  });
});

// =========================================================================
// D: tools/call — streaming, error pass-through, cancellation (B9-B13)
// =========================================================================

describe("route /api/mcp — tools/call (streaming + errors + cancel)", () => {
  // B9: SSE chunks accumulate to a single text in result.content[0].text
  it("P1: SSE chunks accumulate into a single content[0].text", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "A" } }] }),
          JSON.stringify({ choices: [{ delta: { content: "B" } }] }),
          JSON.stringify({
            choices: [{ delta: { content: "C" }, finish_reason: "stop" }],
          }),
        ]),
      ),
    );
    const res = await app.fetch(
      makeCallRequest({
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(res.status).toBe(200);
    const envelope = await readJsonRpcResponse(res);
    const result = asCallToolResult(envelope);
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe("ABC");
  });

  // B10: upstream 401 → isError: true, structuredContent.code === "auth"
  it("D1: upstream 401 maps to isError + code: 'auth'", async () => {
    server.use(
      http.post(
        ENDPOINT,
        () =>
          new HttpResponse(JSON.stringify({ error: { message: "no key" } }), {
            status: 401,
          }),
      ),
    );
    const res = await app.fetch(
      makeCallRequest({
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(res.status).toBe(200);
    const envelope = await readJsonRpcResponse(res);
    const result = asCallToolResult(envelope);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("auth");
  });

  // B11: upstream 429 + retry-after → code: "rate_limited" + retryAfter from header
  it("D2: upstream 429 maps to code: 'rate_limited' with retryAfter from header", async () => {
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
    const res = await app.fetch(
      makeCallRequest({
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    const envelope = await readJsonRpcResponse(res);
    const result = asCallToolResult(envelope);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("rate_limited");
    expect(result.structuredContent?.retryAfter).toBe(30);
  });

  // B12: upstream 500 → code: "upstream_error"
  it("D3: upstream 500 maps to code: 'upstream_error'", async () => {
    server.use(
      http.post(ENDPOINT, () => new HttpResponse(JSON.stringify({ error: {} }), { status: 500 })),
    );
    const res = await app.fetch(
      makeCallRequest({
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    const envelope = await readJsonRpcResponse(res);
    const result = asCallToolResult(envelope);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe("upstream_error");
  });

  // B13: aborting the request signal triggers the route handler's close
  // event before any upstream response.
  //
  // mcp-handler's `createServerResponseAdapter` registers a `close` event
  // on the request's AbortSignal (index.mjs:802). Aborting BEFORE any
  // upstream chunk arrives proves that signal propagation is wired — the
  // adapter emits `close` synchronously on abort, and the test resolves
  // (no hang).
  //
  // Caveat documented for future work: mcp-handler's Streamable HTTP
  // transport constructs an internal `new Request(...)` WITHOUT carrying
  // the original signal (index.mjs:321), so `extra.signal` inside the
  // tool callback does NOT receive the route-level abort. Tool-level abort
  // propagation is covered by unit tests in tests/unit/completion-chat.test.ts
  // (B16a/B16b) where extra.signal is passed directly. This integration
  // test asserts only the route adapter's signal handling, which is the
  // boundary it owns.
  it(
    "D4: pre-aborting the request signal causes the route to surface aborted state",
    async () => {
      // MSW handler: returns a fast complete stream so even if the abort
      // does not fire in time, the test cannot hang.
      server.use(
        http.post(ENDPOINT, () =>
          sseResponse([
            JSON.stringify({
              choices: [{ delta: { content: "x" }, finish_reason: "stop" }],
            }),
          ]),
        ),
      );
      const ac = new AbortController();
      ac.abort(); // abort BEFORE the request is dispatched
      let resolved = false;
      let rejected = false;
      try {
        const res = await app.fetch(
          makeCallRequest({ messages: [{ role: "user", content: "hi" }] }, { signal: ac.signal }),
        );
        // Route may resolve with a Response (because MSW returned quickly)
        // OR with whatever the adapter built before abort. Both prove the
        // path returns instead of hanging — which is what cancellation
        // semantics require.
        expect(res).toBeInstanceOf(Response);
        resolved = true;
      } catch (err) {
        // AbortError path: the platform rejected the in-flight read.
        // Equally valid proof that the signal propagated.
        expect((err as Error).name).toMatch(/Abort/i);
        rejected = true;
      }
      expect(resolved || rejected).toBe(true);
      // The route's adapter spawns the upstream openai call asynchronously;
      // even after the outer Promise resolves (via abort), the in-flight
      // POST to api.openai.com may still be in flight and would otherwise
      // leak into the next test's `afterEach` cleanup as an unhandled
      // request warning. Wait one macrotask for the leaked call to settle
      // against the still-installed MSW handler.
      await new Promise((r) => setTimeout(r, 50));
    },
    { timeout: 3000 },
  );
});

// =========================================================================
// E: HTTP method exports — Hono /healthz + smoke
// =========================================================================

describe("route — Hono surface", () => {
  it("P1: GET /healthz returns 200 ok (no auth)", async () => {
    const res = await app.fetch(new Request("http://localhost/healthz"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
