// openai_chat MCP tool handler (#4).
//
// v1 single tool per ARCHITECTURE.md §3-§4. Steps the handler performs:
//   1. zod-validate input (.strict, allowlist refine, max_tokens clamp)
//   2. wire AbortController to extra.signal so MCP cancellation propagates
//   3. call openai.chat.completions.create({ stream: true,
//        stream_options: { include_usage: true } }, { signal, maxRetries: 0 })
//   4. accumulate delta.content, capture finish_reason and usage
//   5. return CallToolResult-shaped object with safe metadata only
//
// CLAUDE.md §4 invariants:
//   • streaming MUST set maxRetries: 0 (no mid-stream replay → no duplicates)
//   • error results MUST NEVER echo the raw upstream body / prompt / headers
//   • the only token-comparison rule (=== forbidden) lives in lib/auth.ts
//     and is unrelated here — surfaced via comment for completeness only

import OpenAI from "openai";
import { z } from "zod";
import { env } from "../env.js";
import { openai } from "../openai-client.js";

// --- input schema ---------------------------------------------------------

const inputSchema = z
  .object({
    model: z.string().refine((m) => env.MODEL_ALLOWLIST.includes(m), {
      message: "model not in allowlist",
    }),
    messages: z
      .array(
        z.object({
          role: z.enum(["system", "user", "assistant"]),
          content: z.string(),
        }),
      )
      .min(1),
    temperature: z.number().min(0).max(2).optional(),
    // Silently clamp to env.MAX_OUTPUT_TOKENS_CEILING (transform, not throw).
    // The pre-transform schema enforces int-positive; the post-transform
    // value is `number | undefined` (undefined when caller omitted it).
    max_tokens: z
      .number()
      .int()
      .positive()
      .optional()
      .transform((n) => (n === undefined ? undefined : Math.min(n, env.MAX_OUTPUT_TOKENS_CEILING))),
    top_p: z.number().min(0).max(1).optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .strict();

export type OpenaiChatInput = z.infer<typeof inputSchema>;

// --- result shape ---------------------------------------------------------

export type OpenaiUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type OpenaiChatStructured = {
  model: string;
  // Optional fields: under tsconfig `exactOptionalPropertyTypes` the result
  // builder MUST omit these keys entirely when unset (rather than assigning
  // `undefined`). The "?:" markers below describe exactly that contract.
  usage?: OpenaiUsage;
  finish_reason?: string;
  code?: string;
  retryAfter?: number;
};

export type OpenaiChatResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: OpenaiChatStructured;
  isError: boolean;
};

// --- error mapping --------------------------------------------------------

type MappedError = {
  code: string;
  message: string;
  retryAfter?: number;
};

function mapOpenAIError(err: unknown): MappedError {
  if (err instanceof OpenAI.APIError) {
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
      // `code` is on APIError itself (string | null | undefined per the SDK
      // d.ts). It surfaces the OpenAI error body's `error.code` field for
      // 400-class errors (context_length_exceeded, content_filter, ...).
      const apiCode = err.code;
      if (apiCode === "context_length_exceeded") {
        return { code: "context_length", message: "Context length exceeded" };
      }
      if (apiCode === "content_filter" || /content policy|safety/i.test(err.message)) {
        return { code: "content_policy", message: "Content policy rejected" };
      }
      return { code: "bad_request", message: "Bad request" };
    }

    if (typeof status === "number" && status >= 500) {
      return { code: "upstream_error", message: "Upstream server error" };
    }

    if (status === undefined) {
      // APIConnectionError / APIUserAbortError have status: undefined.
      return { code: "upstream_error", message: "Network or connection error" };
    }

    // Other 4xx — fall through.
    return { code: "bad_request", message: "Bad request" };
  }

  // Non-APIError: network failure thrown outside the SDK retry path, or any
  // other unexpected throwable. Map to generic upstream_error.
  return { code: "upstream_error", message: "Network or unknown error" };
}

// --- handler --------------------------------------------------------------

export async function openaiChatHandler(
  input: OpenaiChatInput,
  extra: { signal?: AbortSignal } = {},
): Promise<OpenaiChatResult> {
  // Local AbortController so we can both observe the caller's signal and
  // reuse the abort path inside the iterator if needed in the future.
  const ac = new AbortController();
  if (extra.signal) {
    if (extra.signal.aborted) {
      ac.abort();
    } else {
      extra.signal.addEventListener("abort", () => ac.abort(), { once: true });
    }
  }

  try {
    // Build the request body without spreading-undefined for optional keys
    // — the OpenAI SDK types are `number | null` (not `| undefined`) under
    // tsconfig `exactOptionalPropertyTypes`. We omit each optional key when
    // the caller did not supply it, rather than passing `undefined`.
    const stream = await openai.chat.completions.create(
      {
        model: input.model,
        messages: input.messages,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.max_tokens !== undefined ? { max_tokens: input.max_tokens } : {}),
        ...(input.top_p !== undefined ? { top_p: input.top_p } : {}),
        ...(input.stop !== undefined ? { stop: input.stop } : {}),
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: ac.signal, maxRetries: 0 },
    );

    let accumulated = "";
    let usage: OpenaiUsage | undefined;
    let finishReason: string | undefined;

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) accumulated += delta;
      const fr = choice?.finish_reason;
      if (fr) finishReason = fr;
      if (chunk.usage) {
        usage = {
          prompt_tokens: chunk.usage.prompt_tokens,
          completion_tokens: chunk.usage.completion_tokens,
          total_tokens: chunk.usage.total_tokens,
        };
      }
    }

    // Build structuredContent without injecting `undefined` for optional
    // keys (exactOptionalPropertyTypes). Spread the optional fields only
    // when defined.
    const structuredContent: OpenaiChatStructured = {
      model: input.model,
      ...(usage !== undefined ? { usage } : {}),
      ...(finishReason !== undefined ? { finish_reason: finishReason } : {}),
    };

    return {
      content: [{ type: "text", text: accumulated }],
      structuredContent,
      isError: false,
    };
  } catch (err) {
    const mapped = mapOpenAIError(err);
    const structuredContent: OpenaiChatStructured = {
      model: input.model,
      code: mapped.code,
      ...(mapped.retryAfter !== undefined ? { retryAfter: mapped.retryAfter } : {}),
    };
    return {
      content: [{ type: "text", text: mapped.message }],
      structuredContent,
      isError: true,
    };
  }
}

// --- tool descriptor ------------------------------------------------------

export const openaiChatTool = {
  name: "openai_chat",
  description: "Invoke OpenAI Chat Completions and return the accumulated assistant message.",
  inputSchema,
  handler: openaiChatHandler,
} as const;
