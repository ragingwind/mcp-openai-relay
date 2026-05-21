// Anthropic Messages MCP tool registrar.
//
// `registerAnthropicMessages(server, config)` registers a single MCP tool
// that streams an Anthropic Messages response and returns it as one
// `CallToolResult`. The same server may be safely registered against
// multiple times with different `name` + `apiKey` + `baseURL` —
// every call produces an independent closure (schema, Anthropic client,
// per-request scope, AbortController) with NO module-level shared state.
//
// Streaming invariants:
//   - `maxRetries: 0` at the call site (mid-stream replay would duplicate
//     output).
//
// Error result invariants:
//   - never echo the raw upstream body, prompt, or headers.
//   - map Anthropic errors to the stable `code` set defined below.

import { AsyncLocalStorage } from "node:async_hooks";
import Anthropic from "@anthropic-ai/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dumpMessages, type VerboseLogger } from "../bin/logger.js";
import type { ToolDescriptor } from "../openai/chat.js";
import { type CreatedAnthropicClient, createAnthropicClient, type RequestScope } from "./client.js";

const DEFAULT_NAME = "messages";
const DEFAULT_DESCRIPTION =
  "Invoke Anthropic Messages and return the accumulated assistant message.";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 1024;

// --- config ---------------------------------------------------------------

export interface AnthropicMessagesConfig {
  /** Registered MCP tool name. Default `"messages"`. Must be unique
   *  within an MCP server when multiple instances are registered. */
  name?: string;
  /** Description override. */
  description?: string;
  /** Anthropic API key. Required unless `anthropicClient` is supplied. */
  apiKey: string;
  /** Anthropic base URL override. */
  baseURL?: string;
  /** Model id forwarded to the upstream Messages endpoint. Required. */
  model: string;
  /** Sampling temperature (0..1). When set, forwarded with every call. */
  temperature?: number;
  /** Max tokens forwarded to the upstream. Positive integer. Defaults
   *  to 1024 when omitted (Anthropic requires `max_tokens` per call). */
  max_tokens?: number;
  /** Nucleus sampling cutoff (0..1). When set, forwarded with every call. */
  top_p?: number;
  /** Stop sequence (single string or array). Translated to
   *  `stop_sequences` for the upstream call. */
  stop?: string | string[];
  /** Per-request Anthropic timeout in ms. Default 60_000. */
  requestTimeoutMs?: number;
  /** Inject a pre-built Anthropic client. */
  anthropicClient?: Anthropic;
  /** Inject the request scope that pairs with `anthropicClient`. */
  requestScope?: RequestScope;
  /** Optional verbose logger. */
  logger?: VerboseLogger;
}

// --- input schema ---------------------------------------------------------

export function makeAnthropicMessagesSchema() {
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

export type AnthropicMessagesSchema = ReturnType<typeof makeAnthropicMessagesSchema>;
export type AnthropicMessagesInput = z.infer<AnthropicMessagesSchema>;

export const anthropicMessagesOutputSchema = z
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
  })
  .strict();

// --- result shape ---------------------------------------------------------

export type AnthropicUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type AnthropicMessagesStructured = {
  model: string;
  usage?: AnthropicUsage;
  finish_reason?: string;
  code?: string;
  retryAfter?: number;
};

export type AnthropicMessagesResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: AnthropicMessagesStructured;
  isError: boolean;
};

export type AnthropicMessagesHandler = (
  rawInput: unknown,
  extra?: { signal?: AbortSignal },
) => Promise<AnthropicMessagesResult>;

// --- error mapping --------------------------------------------------------

type MappedError = {
  code: string;
  message: string;
  retryAfter?: number;
};

export function mapAnthropicError(err: unknown, requestScope?: RequestScope): MappedError {
  if (err instanceof Anthropic.APIError) {
    const status = err.status;

    if (status === 401 || status === 403) {
      return { code: "auth", message: "Authentication failed" };
    }

    if (status === 429) {
      const headerVal = err.headers?.get?.("retry-after") ?? "";
      const parsed = Number(headerVal);
      const retryAfter = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
      return retryAfter !== undefined
        ? { code: "rate_limited", message: "Rate limited by upstream", retryAfter }
        : { code: "rate_limited", message: "Rate limited by upstream" };
    }

    if (status === 400) {
      const errType = err.type;
      const msg = err.message ?? "";
      if (errType === "invalid_request_error" && /context/i.test(msg)) {
        return { code: "context_length", message: "Context length exceeded" };
      }
      return { code: "bad_request", message: "Bad request" };
    }

    if (status === 529) {
      const body = requestScope?.getStore()?.upstreamBody;
      return {
        code: "upstream_error",
        message: body ? `Upstream overloaded: ${body}` : "Upstream overloaded",
      };
    }

    if (typeof status === "number" && status >= 500) {
      const body = requestScope?.getStore()?.upstreamBody;
      return {
        code: "upstream_error",
        message: body ? `Upstream server error: ${body}` : "Upstream server error",
      };
    }

    if (status === undefined) {
      return { code: "upstream_error", message: "Network or connection error" };
    }

    return { code: "bad_request", message: "Bad request" };
  }

  return { code: "upstream_error", message: "Network or unknown error" };
}

// --- handler factory ------------------------------------------------------

export interface AnthropicMessagesHandlerBundle {
  schema: AnthropicMessagesSchema;
  handler: AnthropicMessagesHandler;
  /** Resolved tool name (`config.name ?? "messages"`). */
  name: string;
  /** Resolved description. */
  description: string;
}

export function makeAnthropicMessagesHandler(
  config: AnthropicMessagesConfig,
): AnthropicMessagesHandlerBundle {
  if (!config.model || config.model.length === 0) {
    throw new Error("AnthropicMessagesConfig.model is required");
  }
  const name = config.name ?? DEFAULT_NAME;
  const max_tokens = config.max_tokens ?? DEFAULT_MAX_TOKENS;
  const appliedMaxTokensDefault = config.max_tokens === undefined;
  const description = config.description ?? buildDefaultDescription({ ...config, max_tokens });
  const schema = makeAnthropicMessagesSchema();

  const { client, requestScope } = resolveClient(config);
  const logger = config.logger;

  if (appliedMaxTokensDefault && logger?.enabled) {
    logger.log("anthropic-max-tokens-default", {
      model: config.model,
      default: DEFAULT_MAX_TOKENS,
    });
  }

  const handler: AnthropicMessagesHandler = async (rawInput, extra = {}) => {
    const input: AnthropicMessagesInput = schema.parse(rawInput);

    const ac = new AbortController();
    if (extra.signal) {
      if (extra.signal.aborted) {
        ac.abort();
      } else {
        extra.signal.addEventListener("abort", () => ac.abort(), { once: true });
      }
    }

    return requestScope.run({}, () =>
      runOnce(input.messages, { ...config, max_tokens }, client, requestScope, ac, logger),
    );
  };

  return { schema, handler, name, description };
}

export function registerAnthropicMessages(
  server: McpServer,
  config: AnthropicMessagesConfig,
): void {
  const { schema, handler, name, description } = makeAnthropicMessagesHandler(config);
  server.registerTool(
    name,
    {
      description,
      inputSchema: schema.shape,
      outputSchema: anthropicMessagesOutputSchema.shape,
    },
    handler,
  );
}

export function registerAnthropicProvider(
  server: McpServer,
  config: AnthropicMessagesConfig,
): void {
  registerAnthropicMessages(server, config);
}

// --- transport-agnostic tool descriptor ----------------------------------

export const anthropicMessagesTool: ToolDescriptor<
  AnthropicMessagesConfig,
  AnthropicMessagesHandlerBundle
> = {
  provider: "anthropic",
  name: "messages",
  makeHandler: makeAnthropicMessagesHandler,
  desugar: (plain) => ({ messages: [{ role: "user", content: plain }] }),
};

// --- internals ------------------------------------------------------------

function buildDefaultDescription(
  config: Omit<AnthropicMessagesConfig, "max_tokens"> & { max_tokens: number },
): string {
  const hints: string[] = [`model: ${config.model}`, `max_tokens: ${config.max_tokens}`];
  if (config.temperature !== undefined) hints.push(`temperature: ${config.temperature}`);
  if (config.top_p !== undefined) hints.push(`top_p: ${config.top_p}`);
  if (config.stop !== undefined) {
    hints.push(`stop: ${Array.isArray(config.stop) ? JSON.stringify(config.stop) : config.stop}`);
  }
  return `${DEFAULT_DESCRIPTION} (${hints.join(", ")})`;
}

function resolveClient(config: AnthropicMessagesConfig): CreatedAnthropicClient {
  if (config.anthropicClient) {
    return {
      client: config.anthropicClient,
      requestScope: config.requestScope ?? new AsyncLocalStorage(),
    };
  }
  return createAnthropicClient({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(config.logger ? { logger: config.logger } : {}),
  });
}

type ExtractedMessages = {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
};

// Anthropic places the system prompt in a top-level `system` field. The
// caller-facing schema accepts a `system` role inside `messages` (parity
// with OpenAI). Leading consecutive system messages are concatenated; a
// system message after a user/assistant turn is rejected because Anthropic
// has no representation for interleaved system content.
function extractSystem(messages: AnthropicMessagesInput["messages"]): ExtractedMessages {
  const systemParts: string[] = [];
  let i = 0;
  while (i < messages.length && messages[i]?.role === "system") {
    const m = messages[i];
    if (m) systemParts.push(m.content);
    i++;
  }
  const rest: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "system") {
      const err = new Error(
        "Anthropic does not support system messages interleaved with user/assistant turns; place all system messages at the start",
      ) as Error & { code?: string };
      err.code = "bad_request";
      throw err;
    }
    rest.push({ role: m.role, content: m.content });
  }
  const out: ExtractedMessages = { messages: rest };
  if (systemParts.length > 0) out.system = systemParts.join("\n\n");
  return out;
}

function translateStop(stop: string | string[] | undefined): string[] | undefined {
  if (stop === undefined) return undefined;
  const arr = Array.isArray(stop) ? stop : [stop];
  const filtered = arr.filter((s) => typeof s === "string" && s.trim().length > 0);
  return filtered.length > 0 ? filtered : undefined;
}

function mapStopReason(stopReason: string | null | undefined): string | undefined {
  switch (stopReason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return stopReason ?? undefined;
  }
}

async function runOnce(
  rawMessages: AnthropicMessagesInput["messages"],
  config: AnthropicMessagesConfig & { max_tokens: number },
  client: Anthropic,
  requestScope: RequestScope,
  ac: AbortController,
  logger?: VerboseLogger,
): Promise<AnthropicMessagesResult> {
  const startedAt = Date.now();
  const model = config.model;

  let extracted: ExtractedMessages;
  try {
    extracted = extractSystem(rawMessages);
  } catch (err) {
    const e = err as Error & { code?: string };
    const code = e.code ?? "bad_request";
    if (logger?.enabled) {
      logger.log("anthropic-stream-end", {
        accumulatedText: "",
        finish_reason: undefined,
        usage: undefined,
        elapsedMs: Date.now() - startedAt,
        error: { code, message: e.message },
      });
    }
    return {
      content: [{ type: "text", text: e.message }],
      structuredContent: { model, code },
      isError: true,
    };
  }

  const stopSequences = translateStop(config.stop);

  if (logger?.enabled) {
    logger.log("anthropic-stream-start", {
      model,
      messages: dumpMessages(rawMessages),
      ...(extracted.system !== undefined ? { system: extracted.system } : {}),
      max_tokens: config.max_tokens,
      temperature: config.temperature,
      top_p: config.top_p,
      stop_sequences: stopSequences,
      maxRetries: 0,
    });
    if (ac.signal.aborted) {
      logger.log("anthropic-cancelled", {
        reason: ac.signal.reason ?? "aborted",
        elapsedMs: Date.now() - startedAt,
      });
    } else {
      ac.signal.addEventListener(
        "abort",
        () => {
          logger.log("anthropic-cancelled", {
            reason: ac.signal.reason ?? "aborted",
            elapsedMs: Date.now() - startedAt,
          });
        },
        { once: true },
      );
    }
  }

  try {
    const stream = await client.messages.create(
      {
        model,
        messages: extracted.messages,
        max_tokens: config.max_tokens,
        ...(extracted.system !== undefined ? { system: extracted.system } : {}),
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
        ...(config.top_p !== undefined ? { top_p: config.top_p } : {}),
        ...(stopSequences !== undefined ? { stop_sequences: stopSequences } : {}),
        stream: true,
      },
      { signal: ac.signal, maxRetries: 0 },
    );

    let accumulated = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let stopReason: string | null | undefined;

    for await (const event of stream) {
      if (event.type === "message_start") {
        const u = event.message?.usage;
        if (u) inputTokens = u.input_tokens ?? inputTokens;
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta && delta.type === "text_delta") {
          accumulated += delta.text;
        }
      } else if (event.type === "message_delta") {
        if (event.delta?.stop_reason !== undefined) {
          stopReason = event.delta.stop_reason;
        }
        if (event.usage?.output_tokens !== undefined) {
          outputTokens = event.usage.output_tokens;
        }
      }
    }

    if (stopReason === "refusal") {
      const usage = buildUsage(inputTokens, outputTokens);
      const structuredContent: AnthropicMessagesStructured = {
        model,
        code: "content_policy",
        ...(usage ? { usage } : {}),
        finish_reason: "content_filter",
      };
      if (logger?.enabled) {
        logger.log("anthropic-stream-end", {
          accumulatedText: accumulated,
          finish_reason: "content_filter",
          usage,
          elapsedMs: Date.now() - startedAt,
          error: { code: "content_policy", message: "Content policy rejected" },
        });
      }
      return {
        content: [{ type: "text", text: "Content policy rejected" }],
        structuredContent,
        isError: true,
      };
    }

    const usage = buildUsage(inputTokens, outputTokens);
    const finishReason = mapStopReason(stopReason);
    const structuredContent: AnthropicMessagesStructured = {
      model,
      ...(usage ? { usage } : {}),
      ...(finishReason !== undefined ? { finish_reason: finishReason } : {}),
    };

    if (logger?.enabled) {
      logger.log("anthropic-stream-end", {
        accumulatedText: accumulated,
        finish_reason: finishReason,
        usage,
        elapsedMs: Date.now() - startedAt,
      });
    }

    return {
      content: [{ type: "text", text: accumulated }],
      structuredContent,
      isError: false,
    };
  } catch (err) {
    const mapped = mapAnthropicError(err, requestScope);
    const structuredContent: AnthropicMessagesStructured = {
      model,
      code: mapped.code,
      ...(mapped.retryAfter !== undefined ? { retryAfter: mapped.retryAfter } : {}),
    };
    if (logger?.enabled) {
      logger.log("anthropic-stream-end", {
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

function buildUsage(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): AnthropicUsage | undefined {
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const prompt = inputTokens ?? 0;
  const completion = outputTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}
