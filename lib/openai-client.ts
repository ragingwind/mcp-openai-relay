// OpenAI SDK singleton (#4).
//
// One client instance per Vercel worker (cold start), reused across every
// request handled by `lib/tools/openai-chat.ts`. Constructor reads from the
// validated `env` module — never directly from `process.env` (CLAUDE.md §4 /
// plan §2).
//
// `timeout` is per-request and applies to non-streaming calls; streaming
// calls additionally pass `maxRetries: 0` at the call site to prevent
// mid-stream replays from emitting duplicated text (CLAUDE.md §4).

import OpenAI from "openai";
import { env } from "./env.js";

export const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  timeout: env.REQUEST_TIMEOUT_MS,
});
