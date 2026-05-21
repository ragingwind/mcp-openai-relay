// OpenAI Responses MCP tool registrar.
//
// `registerOpenAIResponses(server, config)` registers a single MCP tool that
// streams an OpenAI Responses API response and returns it as one
// `CallToolResult`. The same server may be safely registered against
// multiple times with different `name` + `apiKey` + `baseURL` —
// every call produces an independent closure (schema, OpenAI client,
// per-request scope, AbortController) with NO module-level shared state.
//
// Streaming invariants:
//   - `maxRetries: 0` at the call site (mid-stream replay would duplicate
//     output).
//   - The Responses API exposes accumulated text via
//     `response.output_text.delta` events. Reasoning summaries (when the
//     model and `reasoning_effort` permit) arrive via
//     `response.reasoning_summary_text.delta`. The trailing
//     `response.completed` event carries usage + final status.
//
// Error result invariants:
//   - never echo the raw upstream body, prompt, or headers.
//   - reuse the stable `code` set from `./chat.js` via `mapOpenAIError`.

import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type OpenAI from "openai";
import { z } from "zod";
import { dumpMessages, type VerboseLogger } from "../bin/logger.js";
import { mapOpenAIError, type OpenaiUsage, type ToolDescriptor } from "./chat.js";
import { type CreatedOpenAIClient, createOpenAIClient, type RequestScope } from "./client.js";

const DEFAULT_NAME = "responses";
const DEFAULT_DESCRIPTION =
  "Invoke the OpenAI Responses API and return the accumulated assistant message.";
const DEFAULT_TIMEOUT_MS = 60_000;

// --- config ---------------------------------------------------------------

export interface OpenAIResponsesConfig {
  /** Registered MCP tool name. Default `"responses"`. Must be unique
   *  within an MCP server when multiple instances are registered. */
  name?: string;
  /** Description override. The default summary includes the model id and
   *  any sampling values baked into the server config. */
  description?: string;
  /** OpenAI API key. Required unless `openaiClient` is supplied. */
  apiKey: string;
  /** OpenAI base URL override (Azure / vLLM / Ollama / AI Gateway / mock). */
  baseURL?: string;
  /** Model id forwarded to the upstream Responses endpoint. Required.
   *  The MCP tool inputSchema does not accept a caller-supplied model — the
   *  server is the single source of truth. */
  model: string;
  /** Sampling temperature (0..2). When set, forwarded with every call. */
  temperature?: number;
  /** Max output tokens forwarded to the upstream as `max_output_tokens`.
   *  Positive integer. */
  max_tokens?: number;
  /** Nucleus sampling cutoff (0..1). When set, forwarded with every call. */
  top_p?: number;
  /** Stop sequence (single string or array). When set, forwarded with every call.
   *  Note: the Responses API does not surface a `stop` parameter; this field is
   *  accepted for parity with the Chat config but is not forwarded upstream. */
  stop?: string | string[];
  /** Reasoning effort for gpt-5 / o-series models. When set, forwarded as
   *  `reasoning: { effort: <value> }`. */
  reasoning_effort?: "low" | "medium" | "high";
  /** Per-request OpenAI timeout in ms. Default 60_000. */
  requestTimeoutMs?: number;
  /** Inject a pre-built OpenAI client (advanced — share a client across
   *  multiple registrations to amortise its setup cost). When supplied,
   *  `apiKey` / `baseURL` / `requestTimeoutMs` are ignored. */
  openaiClient?: OpenAI;
  /** Inject the request scope that pairs with `openaiClient`. Required
   *  only when both `openaiClient` is supplied AND upstream-body
   *  redaction must remain wired. */
  requestScope?: RequestScope;
  /** Optional verbose logger. When enabled, emits `openai-stream-start`,
   *  `openai-stream-end`, and `openai-cancelled` events around the
   *  upstream call. */
  logger?: VerboseLogger;
}

// --- input schema ---------------------------------------------------------

export function makeOpenAIResponsesSchema() {
  return z
    .object({
      messages: z
        .array(
          z.object({
            role: z.enum(["system", "user", "assistant"]),
            content: z.string(),
          }),
        )
        .min(1),
    })
    .strict();
}

export type OpenAIResponsesSchema = ReturnType<typeof makeOpenAIResponsesSchema>;
export type OpenAIResponsesInput = z.infer<OpenAIResponsesSchema>;

export const openAIResponsesOutputSchema = z
  .object({
    model: z.string(),
    usage: z
      .object({
        prompt_tokens: z.number(),
        completion_tokens: z.number(),
        total_tokens: z.number(),
      })
      .optional(),
    finish_reason: z.string().optional(),
    code: z.string().optional(),
    retryAfter: z.number().optional(),
    reasoning: z.string().optional(),
  })
  .strict();

// --- result shape ---------------------------------------------------------

export type OpenAIResponsesStructured = {
  model: string;
  usage?: OpenaiUsage;
  finish_reason?: string;
  code?: string;
  retryAfter?: number;
  reasoning?: string;
};

export type OpenAIResponsesResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: OpenAIResponsesStructured;
  isError: boolean;
};

export type OpenAIResponsesHandler = (
  rawInput: unknown,
  extra?: { signal?: AbortSignal },
) => Promise<OpenAIResponsesResult>;

// --- handler factory ------------------------------------------------------

export interface OpenAIResponsesHandlerBundle {
  schema: OpenAIResponsesSchema;
  handler: OpenAIResponsesHandler;
  /** Resolved tool name (`config.name ?? "responses"`). */
  name: string;
  /** Resolved description. */
  description: string;
}

export function makeOpenAIResponsesHandler(
  config: OpenAIResponsesConfig,
): OpenAIResponsesHandlerBundle {
  if (!config.model || config.model.length === 0) {
    throw new Error("OpenAIResponsesConfig.model is required");
  }
  const name = config.name ?? DEFAULT_NAME;
  const description = config.description ?? buildDefaultDescription(config);
  const schema = makeOpenAIResponsesSchema();

  const { client, requestScope } = resolveClient(config);
  const logger = config.logger;

  const handler: OpenAIResponsesHandler = async (rawInput, extra = {}) => {
    const input: OpenAIResponsesInput = schema.parse(rawInput);

    const ac = new AbortController();
    if (extra.signal) {
      if (extra.signal.aborted) {
        ac.abort();
      } else {
        extra.signal.addEventListener("abort", () => ac.abort(), { once: true });
      }
    }

    return requestScope.run({}, () =>
      runOnce(input.messages, config, client, requestScope, ac, logger),
    );
  };

  return { schema, handler, name, description };
}

export function registerOpenAIResponses(server: McpServer, config: OpenAIResponsesConfig): void {
  const { schema, handler, name, description } = makeOpenAIResponsesHandler(config);
  server.registerTool(
    name,
    {
      description,
      inputSchema: schema.shape,
      outputSchema: openAIResponsesOutputSchema.shape,
    },
    handler,
  );
}

// --- transport-agnostic tool descriptor ----------------------------------

export const openAIResponsesTool: ToolDescriptor<
  OpenAIResponsesConfig,
  OpenAIResponsesHandlerBundle
> = {
  provider: "openai",
  name: "responses",
  makeHandler: makeOpenAIResponsesHandler,
  desugar: (plain) => ({ messages: [{ role: "user", content: plain }] }),
};

// --- internals ------------------------------------------------------------

function buildDefaultDescription(config: OpenAIResponsesConfig): string {
  const hints: string[] = [`model: ${config.model}`];
  if (config.temperature !== undefined) hints.push(`temperature: ${config.temperature}`);
  if (config.max_tokens !== undefined) hints.push(`max_tokens: ${config.max_tokens}`);
  if (config.top_p !== undefined) hints.push(`top_p: ${config.top_p}`);
  if (config.stop !== undefined) {
    hints.push(`stop: ${Array.isArray(config.stop) ? JSON.stringify(config.stop) : config.stop}`);
  }
  if (config.reasoning_effort !== undefined) {
    hints.push(`reasoning_effort: ${config.reasoning_effort}`);
  }
  return `${DEFAULT_DESCRIPTION} (${hints.join(", ")})`;
}

function resolveClient(config: OpenAIResponsesConfig): CreatedOpenAIClient {
  if (config.openaiClient) {
    return {
      client: config.openaiClient,
      requestScope: config.requestScope ?? new AsyncLocalStorage(),
    };
  }
  return createOpenAIClient({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(config.logger ? { logger: config.logger } : {}),
  });
}

function translateMessages(messages: OpenAIResponsesInput["messages"]): Array<{
  role: "system" | "user" | "assistant";
  content: Array<{ type: "input_text"; text: string }>;
}> {
  return messages.map((m) => ({
    role: m.role,
    content: [{ type: "input_text" as const, text: m.content }],
  }));
}

async function runOnce(
  messages: OpenAIResponsesInput["messages"],
  config: OpenAIResponsesConfig,
  client: OpenAI,
  requestScope: RequestScope,
  ac: AbortController,
  logger?: VerboseLogger,
): Promise<OpenAIResponsesResult> {
  const startedAt = Date.now();
  const model = config.model;
  if (logger?.enabled) {
    logger.log("openai-stream-start", {
      model,
      messages: dumpMessages(messages),
      temperature: config.temperature,
      max_tokens: config.max_tokens,
      top_p: config.top_p,
      stop: config.stop,
      reasoning_effort: config.reasoning_effort,
      maxRetries: 0,
    });
    if (ac.signal.aborted) {
      logger.log("openai-cancelled", {
        reason: ac.signal.reason ?? "aborted",
        elapsedMs: Date.now() - startedAt,
      });
    } else {
      ac.signal.addEventListener(
        "abort",
        () => {
          logger.log("openai-cancelled", {
            reason: ac.signal.reason ?? "aborted",
            elapsedMs: Date.now() - startedAt,
          });
        },
        { once: true },
      );
    }
  }
  try {
    const input = translateMessages(messages);
    const stream = await client.responses.create(
      {
        model,
        input,
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
        ...(config.max_tokens !== undefined ? { max_output_tokens: config.max_tokens } : {}),
        ...(config.top_p !== undefined ? { top_p: config.top_p } : {}),
        ...(config.reasoning_effort !== undefined
          ? { reasoning: { effort: config.reasoning_effort } }
          : {}),
        stream: true,
      },
      { signal: ac.signal, maxRetries: 0 },
    );

    let accumulated = "";
    let reasoning = "";
    let usage: OpenaiUsage | undefined;
    let finishReason: string | undefined;

    for await (const event of stream) {
      const t = (event as { type?: string }).type;
      if (t === "response.output_text.delta") {
        const delta = (event as { delta?: string }).delta;
        if (typeof delta === "string") accumulated += delta;
      } else if (t === "response.reasoning_summary_text.delta") {
        const delta = (event as { delta?: string }).delta;
        if (typeof delta === "string") reasoning += delta;
      } else if (t === "response.completed") {
        const r = (
          event as {
            response?: {
              usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
              status?: string;
            };
          }
        ).response;
        if (r?.usage) {
          const inputTokens = r.usage.input_tokens ?? 0;
          const outputTokens = r.usage.output_tokens ?? 0;
          const totalTokens = r.usage.total_tokens ?? inputTokens + outputTokens;
          usage = {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: totalTokens,
          };
        }
        if (typeof r?.status === "string") finishReason = r.status;
      }
    }

    const structuredContent: OpenAIResponsesStructured = {
      model,
      ...(usage !== undefined ? { usage } : {}),
      ...(finishReason !== undefined ? { finish_reason: finishReason } : {}),
      ...(reasoning.length > 0 ? { reasoning } : {}),
    };

    if (logger?.enabled) {
      logger.log("openai-stream-end", {
        accumulatedText: accumulated,
        finish_reason: finishReason,
        usage,
        reasoning: reasoning.length > 0 ? reasoning : undefined,
        elapsedMs: Date.now() - startedAt,
      });
    }

    return {
      content: [{ type: "text", text: accumulated }],
      structuredContent,
      isError: false,
    };
  } catch (err) {
    const mapped = mapOpenAIError(err, requestScope);
    const structuredContent: OpenAIResponsesStructured = {
      model,
      code: mapped.code,
      ...(mapped.retryAfter !== undefined ? { retryAfter: mapped.retryAfter } : {}),
    };
    if (logger?.enabled) {
      logger.log("openai-stream-end", {
        accumulatedText: "",
        finish_reason: undefined,
        usage: undefined,
        elapsedMs: Date.now() - startedAt,
        error: { code: mapped.code, message: mapped.message },
      });
    }
    return {
      content: [{ type: "text", text: mapped.message }],
      structuredContent,
      isError: true,
    };
  }
}
