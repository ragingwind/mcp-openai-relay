// Multi-registration unit test — proves `registerOpenAIChat` is callable
// any number of times on the same MCP server with independent config, and
// that each registered handler captures its own apiKey / baseURL / ceiling
// via closure (no module-level shared state, no cross-talk).
//
// This is the contract that lets one MCP server host multiple upstreams
// (OpenAI proper + Azure + local vLLM, etc.) as distinct named tools.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerAnthropicMessages } from "../../src/anthropic/messages.js";
import {
  makeGoogleGenerateContentHandler,
  registerGoogleGenerateContent,
} from "../../src/google/generate-content.js";
import { makeOpenAIChatHandler, registerOpenAIChat } from "../../src/openai/chat.js";
import { makeOpenAIResponsesHandler, registerOpenAIResponses } from "../../src/openai/responses.js";

const mswServer = setupServer();
beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

const VALID_MODEL = "gpt-4o-mini";
const VALID_MESSAGES = [{ role: "user" as const, content: "ping" }];

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

function sseResponse(text: string) {
  return new HttpResponse(
    sseStream([JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })]),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function responsesSSEResponse(text: string) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      c.enqueue(
        enc.encode(
          `event: response.output_text.delta\ndata: ${JSON.stringify({
            type: "response.output_text.delta",
            delta: text,
          })}\n\n`,
        ),
      );
      c.enqueue(
        enc.encode(
          `event: response.completed\ndata: ${JSON.stringify({
            type: "response.completed",
            response: { status: "completed" },
          })}\n\n`,
        ),
      );
      c.close();
    },
  });
  return new HttpResponse(body, { headers: { "content-type": "text/event-stream" } });
}

describe("registerOpenAIChat — multi-registration on one McpServer", () => {
  it("P1: registers three tools with distinct names without throwing", () => {
    const server = new McpServer({ name: "multi-relay-test", version: "0.0.1" });
    expect(() => {
      registerOpenAIChat(server, {
        name: "chat-completions-primary",
        apiKey: "key-openai",
        model: VALID_MODEL,
      });
      registerOpenAIChat(server, {
        name: "azure_chat",
        apiKey: "key-azure",
        baseURL: "https://azure.example.com/v1",
        model: VALID_MODEL,
      });
      registerOpenAIChat(server, {
        name: "local_llm",
        apiKey: "key-local",
        baseURL: "http://localhost:11434/v1",
        model: "llama3",
      });
    }).not.toThrow();
  });

  it("P2: registers OpenAI Chat + Anthropic Messages on the same server (cross-provider type contract)", () => {
    // NOTE: This is a unit-level type-system check. Per D8 (doc/ARCHITECTURE.md
    // §1), deployed processes MUST run a single provider at a time — this
    // test does NOT condone multi-provider production deployments.
    const server = new McpServer({ name: "cross-provider-test", version: "0.0.1" });
    expect(() => {
      registerOpenAIChat(server, {
        name: "chat-completions",
        apiKey: "key-openai",
        model: VALID_MODEL,
      });
      registerAnthropicMessages(server, {
        name: "messages",
        apiKey: "key-anthropic",
        model: "claude-sonnet-4-5",
      });
    }).not.toThrow();
  });

  it("P3: registers OpenAI + Anthropic + Google on the same server (three-provider type contract)", () => {
    const server = new McpServer({ name: "three-provider-test", version: "0.0.1" });
    expect(() => {
      registerOpenAIChat(server, {
        name: "chat-completions",
        apiKey: "key-openai",
        model: VALID_MODEL,
      });
      registerAnthropicMessages(server, {
        name: "messages",
        apiKey: "key-anthropic",
        model: "claude-sonnet-4-5",
      });
      registerGoogleGenerateContent(server, {
        name: "generate-content",
        apiKey: "key-google",
        model: "gemini-2.0-flash",
      });
    }).not.toThrow();
  });

  it("D1: rejects duplicate tool names on the same server", () => {
    const server = new McpServer({ name: "multi-relay-test", version: "0.0.1" });
    registerOpenAIChat(server, {
      name: "completion_chat",
      apiKey: "key-1",
      model: VALID_MODEL,
    });
    expect(() => {
      registerOpenAIChat(server, {
        name: "completion_chat",
        apiKey: "key-2",
        model: VALID_MODEL,
      });
    }).toThrow();
  });
});

describe("makeOpenAIChatHandler — closure isolation across handlers", () => {
  it("P1: each handler routes to its own baseURL with its own apiKey", async () => {
    let openaiAuth: string | null = null;
    let azureAuth: string | null = null;

    mswServer.use(
      http.post("https://api.openai.com/v1/chat/completions", ({ request }) => {
        openaiAuth = request.headers.get("authorization");
        return sseResponse("from-openai");
      }),
      http.post("https://azure.example.com/v1/chat/completions", ({ request }) => {
        azureAuth = request.headers.get("authorization");
        return sseResponse("from-azure");
      }),
    );

    const a = makeOpenAIChatHandler({
      name: "chat-completions-primary",
      apiKey: "key-openai",
      model: VALID_MODEL,
    });
    const b = makeOpenAIChatHandler({
      name: "azure_chat",
      apiKey: "key-azure",
      baseURL: "https://azure.example.com/v1",
      model: VALID_MODEL,
    });

    const ra = await a.handler({ messages: VALID_MESSAGES });
    const rb = await b.handler({ messages: VALID_MESSAGES });

    expect(ra.isError).toBe(false);
    expect(rb.isError).toBe(false);
    expect(ra.content[0]?.text).toBe("from-openai");
    expect(rb.content[0]?.text).toBe("from-azure");
    expect(openaiAuth).toBe("Bearer key-openai");
    expect(azureAuth).toBe("Bearer key-azure");
  });

  it("P2: each handler forwards its own max_tokens config", async () => {
    let observedAtA: number | undefined;
    let observedAtB: number | undefined;

    mswServer.use(
      http.post("https://a.example.com/v1/chat/completions", async ({ request }) => {
        const body = (await request.json()) as { max_tokens?: number };
        observedAtA = body.max_tokens;
        return sseResponse("a");
      }),
      http.post("https://b.example.com/v1/chat/completions", async ({ request }) => {
        const body = (await request.json()) as { max_tokens?: number };
        observedAtB = body.max_tokens;
        return sseResponse("b");
      }),
    );

    const a = makeOpenAIChatHandler({
      apiKey: "key-a",
      baseURL: "https://a.example.com/v1",
      model: VALID_MODEL,
      max_tokens: 100,
    });
    const b = makeOpenAIChatHandler({
      apiKey: "key-b",
      baseURL: "https://b.example.com/v1",
      model: VALID_MODEL,
      max_tokens: 8000,
    });

    await a.handler({ messages: VALID_MESSAGES });
    await b.handler({ messages: VALID_MESSAGES });

    expect(observedAtA).toBe(100);
    expect(observedAtB).toBe(8000);
  });

  it("D1: aborting one handler does not affect a concurrent call on another", async () => {
    // a: never-closing stream, will be aborted.
    // b: completes normally.
    mswServer.use(
      http.post(
        "https://a.example.com/v1/chat/completions",
        () =>
          new HttpResponse(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const enc = new TextEncoder();
                controller.enqueue(
                  enc.encode(
                    `data: ${JSON.stringify({
                      choices: [{ delta: { content: "partial-a" } }],
                    })}\n\n`,
                  ),
                );
                // intentionally never closes
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
      http.post("https://b.example.com/v1/chat/completions", () => sseResponse("done-b")),
    );

    const a = makeOpenAIChatHandler({
      apiKey: "key-a",
      baseURL: "https://a.example.com/v1",
      model: VALID_MODEL,
    });
    const b = makeOpenAIChatHandler({
      apiKey: "key-b",
      baseURL: "https://b.example.com/v1",
      model: VALID_MODEL,
    });

    const acA = new AbortController();
    const promiseA = a.handler({ messages: VALID_MESSAGES }, { signal: acA.signal });
    const promiseB = b.handler({ messages: VALID_MESSAGES });

    await Promise.resolve();
    acA.abort();

    const [resA, resB] = await Promise.all([promiseA, promiseB]);

    expect(resA.isError).toBe(true);
    expect(resA.structuredContent.code).toBe("upstream_error");
    expect(resB.isError).toBe(false);
    expect(resB.content[0]?.text).toBe("done-b");
  });
});

describe("registerOpenAIChat + registerOpenAIResponses — provider-one API-many", () => {
  it("P3: registers both tools on same server without throwing", () => {
    const server = new McpServer({ name: "openai-multi-api-test", version: "0.0.1" });
    expect(() => {
      registerOpenAIChat(server, {
        name: "chat-completions",
        apiKey: "key-openai",
        model: VALID_MODEL,
      });
      registerOpenAIResponses(server, {
        name: "responses",
        apiKey: "key-openai",
        model: VALID_MODEL,
      });
    }).not.toThrow();
  });

  it("P3: distinct tool names — concurrent calls do not cross-talk", async () => {
    let chatHits = 0;
    let responsesHits = 0;

    mswServer.use(
      http.post("https://chat-host.example.com/v1/chat/completions", () => {
        chatHits++;
        return sseResponse("from-chat");
      }),
      http.post("https://responses-host.example.com/v1/responses", () => {
        responsesHits++;
        return responsesSSEResponse("from-responses");
      }),
    );

    const chat = makeOpenAIChatHandler({
      apiKey: "key-chat",
      baseURL: "https://chat-host.example.com/v1",
      model: VALID_MODEL,
    });
    const responses = makeOpenAIResponsesHandler({
      apiKey: "key-responses",
      baseURL: "https://responses-host.example.com/v1",
      model: VALID_MODEL,
    });

    const [chatResult, responsesResult] = await Promise.all([
      chat.handler({ messages: VALID_MESSAGES }),
      responses.handler({ messages: VALID_MESSAGES }),
    ]);

    expect(chatResult.isError).toBe(false);
    expect(chatResult.content[0]?.text).toBe("from-chat");
    expect(responsesResult.isError).toBe(false);
    expect(responsesResult.content[0]?.text).toBe("from-responses");
    expect(chatHits).toBe(1);
    expect(responsesHits).toBe(1);
  });
});

describe("makeGoogleGenerateContentHandler — closure isolation across handlers", () => {
  it("P1: each Google handler routes to its own API key (closure isolation)", async () => {
    const enc = new TextEncoder();
    const chunkOk = (text: string): unknown => ({
      candidates: [
        {
          content: { role: "model", parts: [{ text }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    });
    const sseFor = (text: string) =>
      new HttpResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(chunkOk(text))}\r\n\r\n`));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );

    const seenKeys: string[] = [];
    const captureKey = (request: Request) => {
      const url = new URL(request.url);
      const key = url.searchParams.get("key") ?? request.headers.get("x-goog-api-key") ?? "";
      if (key) seenKeys.push(key);
    };

    mswServer.use(
      http.post(
        "https://gemini-a.example.com/v1beta/models/gemini-2.0-flash:streamGenerateContent",
        ({ request }) => {
          captureKey(request);
          return sseFor("from-a");
        },
      ),
      http.post(
        "https://gemini-b.example.com/v1beta/models/gemini-2.0-flash:streamGenerateContent",
        ({ request }) => {
          captureKey(request);
          return sseFor("from-b");
        },
      ),
    );

    const a = makeGoogleGenerateContentHandler({
      apiKey: "key-google-a",
      baseURL: "https://gemini-a.example.com/",
      model: "gemini-2.0-flash",
    });
    const b = makeGoogleGenerateContentHandler({
      apiKey: "key-google-b",
      baseURL: "https://gemini-b.example.com/",
      model: "gemini-2.0-flash",
    });

    const ra = await a.handler({ messages: VALID_MESSAGES });
    const rb = await b.handler({ messages: VALID_MESSAGES });

    expect(ra.isError).toBe(false);
    expect(rb.isError).toBe(false);
    expect(ra.content[0]?.text).toBe("from-a");
    expect(rb.content[0]?.text).toBe("from-b");
    expect(seenKeys).toContain("key-google-a");
    expect(seenKeys).toContain("key-google-b");
  });
});
