// Google Gemini Generate-Content MCP tool registrar.
//
// `registerGoogleGenerateContent(server, config)` registers a single MCP
// tool that streams a Gemini `generateContentStream` response and returns
// the accumulated text as one `CallToolResult`. The same server may be
// registered against multiple times with different `name` + `apiKey` +
// `baseURL` — every call produces an independent closure with NO
// module-level shared state.
//
// Error result invariants:
//   - never echo the raw upstream body, prompt, or headers.
//   - map Gemini errors (`ApiError`) to the stable `code` set defined below.

import { ApiError, type GoogleGenAI } from "@google/genai";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VerboseLogger } from "../bin/logger.js";
import type { ToolDescriptor } from "../openai/chat.js";
import { type CreatedGoogleClient, createGoogleClient } from "./client.js";

const DEFAULT_NAME = "generate-content";
const DEFAULT_DESCRIPTION =
  "Invoke Google Gemini generate-content and return the accumulated assistant message.";
const DEFAULT_TIMEOUT_MS = 60_000;

// --- config ---------------------------------------------------------------

export interface GoogleGenerateContentConfig {
  /** Registered MCP tool name. Default `"generate-content"`. */
  name?: string;
  /** Description override. */
  description?: string;
  /** Gemini API key. Required unless `googleClient` is supplied. */
  apiKey: string;
  /** Gemini base URL override. */
  baseURL?: string;
  /** Model id forwarded to the upstream. Required. */
  model: string;
  /** Sampling temperature. When set, forwarded with every call. */
  temperature?: number;
  /** Max tokens — forwarded as `maxOutputTokens`. */
  max_tokens?: number;
  /** Nucleus sampling cutoff — forwarded as `topP`. */
  top_p?: number;
  /** Stop sequence (string, comma-separated string, or array). */
  stop?: string | string[];
  /** Per-request timeout in ms. Default 60_000. */
  requestTimeoutMs?: number;
  /** Inject a pre-built GoogleGenAI client. */
  googleClient?: GoogleGenAI;
  /** Optional verbose logger. */
  logger?: VerboseLogger;
}

// --- input schema ---------------------------------------------------------

export function makeGoogleGenerateContentSchema() {
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

export type GoogleGenerateContentSchema = ReturnType<typeof makeGoogleGenerateContentSchema>;
export type GoogleGenerateContentInput = z.infer<GoogleGenerateContentSchema>;

export const googleGenerateContentOutputSchema = z
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

export type GoogleUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type GoogleGenerateContentStructured = {
  model: string;
  usage?: GoogleUsage;
  finish_reason?: string;
  code?: string;
  retryAfter?: number;
};

export type GoogleGenerateContentResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: GoogleGenerateContentStructured;
  isError: boolean;
};

export type GoogleGenerateContentHandler = (
  rawInput: unknown,
  extra?: { signal?: AbortSignal },
) => Promise<GoogleGenerateContentResult>;

// --- error mapping --------------------------------------------------------

type MappedError = {
  code: string;
  message: string;
  retryAfter?: number;
};

export function mapGoogleError(err: unknown): MappedError {
  if (err instanceof ApiError) {
    const status = err.status;

    if (status === 401 || status === 403) {
      return { code: "auth", message: "Authentication failed" };
    }

    if (status === 429) {
      return { code: "rate_limited", message: "Rate limited by upstream" };
    }

    if (status === 400) {
      const body = err.message ?? "";
      const isInvalidArgument =
        /"status"\s*:\s*"INVALID_ARGUMENT"/i.test(body) || /INVALID_ARGUMENT/.test(body);
      if (isInvalidArgument && /context/i.test(body)) {
        return { code: "context_length", message: "Context length exceeded" };
      }
      return { code: "bad_request", message: "Bad request" };
    }

    if (typeof status === "number" && status >= 500) {
      return { code: "upstream_error", message: "Upstream server error" };
    }

    return { code: "bad_request", message: "Bad request" };
  }

  // With retryOptions set, @google/genai's apiCall throws plain Error /
  // AbortError with statusText embedded in the message. Status code and
  // response body are not retained, so 400-context_length cannot be
  // distinguished from generic 400.
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes("Too Many Requests")) {
      return { code: "rate_limited", message: "Rate limited by upstream" };
    }
    if (msg.includes("Unauthorized") || msg.includes("Forbidden")) {
      return { code: "auth", message: "Authentication failed" };
    }
    if (msg.includes("Bad Request") || msg.includes("INVALID_ARGUMENT")) {
      return { code: "bad_request", message: "Bad request" };
    }
    if (
      msg.includes("Internal Server Error") ||
      msg.includes("Service Unavailable") ||
      msg.includes("Bad Gateway") ||
      msg.includes("Gateway Timeout") ||
      msg.includes("Request Timeout") ||
      msg.includes("Retryable HTTP Error")
    ) {
      return { code: "upstream_error", message: "Upstream server error" };
    }
  }

  return { code: "upstream_error", message: "Network or unknown error" };
}

// --- handler factory ------------------------------------------------------

export interface GoogleGenerateContentHandlerBundle {
  schema: GoogleGenerateContentSchema;
  handler: GoogleGenerateContentHandler;
  /** Resolved tool name (`config.name ?? "generate-content"`). */
  name: string;
  /** Resolved description. */
  description: string;
}

export function makeGoogleGenerateContentHandler(
  config: GoogleGenerateContentConfig,
): GoogleGenerateContentHandlerBundle {
  if (!config.model || config.model.length === 0) {
    throw new Error("GoogleGenerateContentConfig.model is required");
  }
  const name = config.name ?? DEFAULT_NAME;
  const description = config.description ?? buildDefaultDescription(config);
  const schema = makeGoogleGenerateContentSchema();

  const { client } = resolveClient(config);
  const logger = config.logger;

  const handler: GoogleGenerateContentHandler = async (rawInput, extra = {}) => {
    const input: GoogleGenerateContentInput = schema.parse(rawInput);

    const ac = new AbortController();
    if (extra.signal) {
      if (extra.signal.aborted) {
        ac.abort();
      } else {
        extra.signal.addEventListener("abort", () => ac.abort(), { once: true });
      }
    }

    return runOnce(input.messages, config, client, ac, logger);
  };

  return { schema, handler, name, description };
}

export function registerGoogleGenerateContent(
  server: McpServer,
  config: GoogleGenerateContentConfig,
): void {
  const { schema, handler, name, description } = makeGoogleGenerateContentHandler(config);
  server.registerTool(
    name,
    {
      description,
      inputSchema: schema.shape,
      outputSchema: googleGenerateContentOutputSchema.shape,
    },
    handler,
  );
}

export function registerGoogleProvider(
  server: McpServer,
  config: GoogleGenerateContentConfig,
): void {
  registerGoogleGenerateContent(server, config);
}

// --- transport-agnostic tool descriptor ----------------------------------

export const googleGenerateContentTool: ToolDescriptor<
  GoogleGenerateContentConfig,
  GoogleGenerateContentHandlerBundle
> = {
  provider: "google",
  name: "generate-content",
  makeHandler: makeGoogleGenerateContentHandler,
  desugar: (plain) => ({ messages: [{ role: "user", content: plain }] }),
};

// --- internals ------------------------------------------------------------

function buildDefaultDescription(config: GoogleGenerateContentConfig): string {
  const hints: string[] = [`model: ${config.model}`];
  if (config.temperature !== undefined) hints.push(`temperature: ${config.temperature}`);
  if (config.max_tokens !== undefined) hints.push(`max_tokens: ${config.max_tokens}`);
  if (config.top_p !== undefined) hints.push(`top_p: ${config.top_p}`);
  if (config.stop !== undefined) {
    hints.push(`stop: ${Array.isArray(config.stop) ? JSON.stringify(config.stop) : config.stop}`);
  }
  return `${DEFAULT_DESCRIPTION} (${hints.join(", ")})`;
}

function resolveClient(config: GoogleGenerateContentConfig): CreatedGoogleClient {
  if (config.googleClient) {
    return { client: config.googleClient };
  }
  return createGoogleClient({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}

type GoogleContent = { role: "user" | "model"; parts: Array<{ text: string }> };

type TranslatedMessages = {
  systemInstruction?: string;
  contents: GoogleContent[];
};

// Gemini places the system prompt in a top-level `systemInstruction` field.
// The caller-facing schema accepts a `system` role (parity with OpenAI).
// Leading consecutive system messages are concatenated; a system message
// after a user/assistant turn is rejected because Gemini has no
// representation for interleaved system content.
function translateMessages(messages: GoogleGenerateContentInput["messages"]): TranslatedMessages {
  const systemParts: string[] = [];
  let i = 0;
  while (i < messages.length && messages[i]?.role === "system") {
    const m = messages[i];
    if (m) systemParts.push(m.content);
    i++;
  }

  const contents: GoogleContent[] = [];
  for (; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "system") {
      const err = new Error(
        "Gemini does not support system messages interleaved with user/assistant turns; place all system messages at the start",
      ) as Error & { code?: string };
      err.code = "bad_request";
      throw err;
    }
    const role: "user" | "model" = m.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push({ text: m.content });
    } else {
      contents.push({ role, parts: [{ text: m.content }] });
    }
  }

  const out: TranslatedMessages = { contents };
  if (systemParts.length > 0) out.systemInstruction = systemParts.join("\n\n");
  return out;
}

function translateStop(stop: string | string[] | undefined): string[] | undefined {
  if (stop === undefined) return undefined;
  const arr = Array.isArray(stop) ? stop : stop.includes(",") ? stop.split(",") : [stop];
  const filtered = arr.map((s) => s.trim()).filter((s) => s.length > 0);
  return filtered.length > 0 ? filtered : undefined;
}

function mapFinishReason(reason: string | undefined): {
  finish_reason?: string;
  isContentPolicy: boolean;
} {
  if (!reason) return { isContentPolicy: false };
  if (reason === "SAFETY" || reason === "RECITATION") {
    return { isContentPolicy: true };
  }
  switch (reason) {
    case "STOP":
      return { finish_reason: "stop", isContentPolicy: false };
    case "MAX_TOKENS":
      return { finish_reason: "length", isContentPolicy: false };
    default:
      return { finish_reason: reason.toLowerCase(), isContentPolicy: false };
  }
}

type GeminiUsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
};

async function runOnce(
  rawMessages: GoogleGenerateContentInput["messages"],
  config: GoogleGenerateContentConfig,
  client: GoogleGenAI,
  ac: AbortController,
  logger?: VerboseLogger,
): Promise<GoogleGenerateContentResult> {
  const startedAt = Date.now();
  const model = config.model;

  let translated: TranslatedMessages;
  try {
    translated = translateMessages(rawMessages);
  } catch (err) {
    const e = err as Error & { code?: string };
    const code = e.code ?? "bad_request";
    if (logger?.enabled) {
      logger.log("google-stream-end", {
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

  const generationConfig: Record<string, unknown> = {};
  if (config.temperature !== undefined) generationConfig.temperature = config.temperature;
  if (config.top_p !== undefined) generationConfig.topP = config.top_p;
  if (config.max_tokens !== undefined) generationConfig.maxOutputTokens = config.max_tokens;
  if (stopSequences !== undefined) generationConfig.stopSequences = stopSequences;

  if (logger?.enabled) {
    logger.log("google-stream-start", {
      model,
      contents: translated.contents,
      ...(translated.systemInstruction !== undefined
        ? { systemInstruction: translated.systemInstruction }
        : {}),
      generationConfig,
    });
  }

  try {
    const stream = await client.models.generateContentStream({
      model,
      contents: translated.contents,
      config: {
        ...(translated.systemInstruction !== undefined
          ? { systemInstruction: translated.systemInstruction }
          : {}),
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
        ...(config.top_p !== undefined ? { topP: config.top_p } : {}),
        ...(config.max_tokens !== undefined ? { maxOutputTokens: config.max_tokens } : {}),
        ...(stopSequences !== undefined ? { stopSequences } : {}),
        abortSignal: ac.signal,
      },
    });

    let accumulated = "";
    let lastUsage: GeminiUsageMetadata | undefined;
    let lastFinishReason: string | undefined;

    for await (const chunk of stream) {
      const cand = chunk.candidates?.[0];
      const text = cand?.content?.parts?.[0]?.text ?? "";
      accumulated += text;
      if (cand?.finishReason) {
        lastFinishReason = cand.finishReason;
      }
      if (chunk.usageMetadata) {
        lastUsage = chunk.usageMetadata as GeminiUsageMetadata;
      }
    }

    const mapped = mapFinishReason(lastFinishReason);
    const usage = buildUsage(lastUsage);

    if (mapped.isContentPolicy) {
      const structuredContent: GoogleGenerateContentStructured = {
        model,
        code: "content_policy",
        ...(usage ? { usage } : {}),
        finish_reason: "content_filter",
      };
      if (logger?.enabled) {
        logger.log("google-stream-end", {
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

    const structuredContent: GoogleGenerateContentStructured = {
      model,
      ...(usage ? { usage } : {}),
      ...(mapped.finish_reason !== undefined ? { finish_reason: mapped.finish_reason } : {}),
    };

    if (logger?.enabled) {
      logger.log("google-stream-end", {
        accumulatedText: accumulated,
        finish_reason: mapped.finish_reason,
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
    const mapped = mapGoogleError(err);
    const structuredContent: GoogleGenerateContentStructured = {
      model,
      code: mapped.code,
      ...(mapped.retryAfter !== undefined ? { retryAfter: mapped.retryAfter } : {}),
    };
    if (logger?.enabled) {
      logger.log("google-stream-end", {
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

function buildUsage(usage: GeminiUsageMetadata | undefined): GoogleUsage | undefined {
  if (!usage) return undefined;
  if (
    usage.promptTokenCount === undefined &&
    usage.candidatesTokenCount === undefined &&
    usage.totalTokenCount === undefined
  ) {
    return undefined;
  }
  const prompt = usage.promptTokenCount ?? 0;
  const completion = usage.candidatesTokenCount ?? 0;
  const total = usage.totalTokenCount ?? prompt + completion;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
}
