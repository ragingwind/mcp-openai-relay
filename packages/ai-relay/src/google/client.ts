// Google Gemini client factory. Mirrors the OpenAI/Anthropic factories.
//
// Each call to `createGoogleClient` produces a fresh `GoogleGenAI` instance.
// `@google/genai` v2 does not expose a custom-fetch / fetchImplementation
// hook on the public `GoogleGenAIOptions` surface, so upstream-error body
// capture is not wired here today (the `mapGoogleError` mapper extracts the
// SDK's stringified-JSON `ApiError.message` directly).

import { GoogleGenAI } from "@google/genai";

export interface GoogleClientConfig {
  /** Gemini API key. Required. */
  apiKey: string;
  /** Override the Gemini base URL (e.g. for self-hosted gateway / mock). */
  baseURL?: string;
  /** Per-request timeout in ms. Default 60_000. */
  requestTimeoutMs?: number;
}

export interface CreatedGoogleClient {
  client: GoogleGenAI;
}

export function createGoogleClient(config: GoogleClientConfig): CreatedGoogleClient {
  const httpOptions: Record<string, unknown> = {
    retryOptions: { attempts: 1 },
  };
  if (config.baseURL) httpOptions.baseUrl = config.baseURL;
  if (config.requestTimeoutMs !== undefined) httpOptions.timeout = config.requestTimeoutMs;

  const client = new GoogleGenAI({
    apiKey: config.apiKey,
    httpOptions,
  });

  return { client };
}
