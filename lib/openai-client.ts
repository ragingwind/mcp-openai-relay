// OpenAI SDK singleton (#4).
//
// One client instance per Vercel worker (cold start), reused across every
// request handled by `lib/tools/completion-chat.ts`. Constructor reads from the
// validated `env` module — never directly from `process.env` (CLAUDE.md §4 /
// plan §2).
//
// `timeout` is per-request and applies to non-streaming calls; streaming
// calls additionally pass `maxRetries: 0` at the call site to prevent
// mid-stream replays from emitting duplicated text (CLAUDE.md §4).

import { AsyncLocalStorage } from "node:async_hooks";
import OpenAI from "openai";
import { env } from "./env.js";

const UPSTREAM_BODY_MAX_CHARS = 512;

type RequestScope = { upstreamBody?: string };

export const requestScope = new AsyncLocalStorage<RequestScope>();

const baseFetch: typeof fetch = globalThis.fetch.bind(globalThis);

function redactSecrets(s: string): string {
  let out = s;
  for (const secret of [env.OPENAI_API_KEY, env.RELAY_AUTH_TOKEN]) {
    if (secret && secret.length > 0) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  return out;
}

const captureFetch: typeof fetch = async (input, init) => {
  const res = await baseFetch(input, init);
  if (!res.ok) {
    const store = requestScope.getStore();
    if (store) {
      try {
        const text = await res.clone().text();
        if (text) store.upstreamBody = redactSecrets(text).slice(0, UPSTREAM_BODY_MAX_CHARS);
      } catch {
        /* body unreadable; SDK's own message remains the fallback */
      }
    }
  }
  return res;
};

export const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  timeout: env.REQUEST_TIMEOUT_MS,
  fetch: captureFetch,
  ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
});
