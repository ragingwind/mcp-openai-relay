// HTTP-only environment parser for the relay app.
//
// This is the relay app's private env schema — it lives in `app/src/`
// because `AI_RELAY_AUTH_TOKEN` (≥ 32 bytes) and `AI_RELAY_PORT` are
// HTTP-server-specific concerns, NOT of every consumer that embeds the
// `ai-relay` SDK in a stdio launcher, Cloudflare Worker, or Hono server
// elsewhere. The other keys share the `AI_RELAY_*` namespace with the SDK
// so a single env vocabulary serves both the CLI and the HTTP transport.
//
// Side-effect-free module: importing this file does NOT read process.env.
// Consumers (the entry file, scripts, tests) call `parseEnv(source)`
// explicitly with whatever object they want validated.
//
// Error messages MUST never echo any env var value. Failure messages
// are built strictly from `issue.path` + `issue.message` text.

import { z } from "zod";

const emptyToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim().length === 0 ? undefined : v;

const stopListSchema = z.preprocess((v) => {
  if (typeof v !== "string" || v.trim().length === 0) return undefined;
  const parts = v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return parts;
}, z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional());

// Schema is intentionally non-strict: process.env carries unrelated keys
// (PATH, HOME, etc.). AI_RELAY_API_KEY.min(1) enforces the migration error
// loudly instead of silently defaulting to an empty key that would fail
// with an obscure upstream 401.
const envSchema = z.object({
  AI_RELAY_API_KEY: z.string().min(1, "AI_RELAY_API_KEY is required"),
  AI_RELAY_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  AI_RELAY_AUTH_TOKEN: z
    .string()
    .refine((s) => Buffer.byteLength(s, "utf8") >= 32, "must be at least 32 bytes"),
  AI_RELAY_MODEL: z.string().min(1, "AI_RELAY_MODEL is required"),
  AI_RELAY_TEMPERATURE: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(2).optional()),
  AI_RELAY_MAX_TOKENS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().optional(),
  ),
  AI_RELAY_TOP_P: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(1).optional()),
  AI_RELAY_STOP: stopListSchema,
  AI_RELAY_REASONING_EFFORT: z.preprocess(
    emptyToUndefined,
    z.enum(["low", "medium", "high"]).optional(),
  ),
  AI_RELAY_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  AI_RELAY_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
});

export type Env = z.infer<typeof envSchema>;

// Permissive env-shaped input. `process.env` itself satisfies this signature.
export type EnvSource = Record<string, string | undefined>;

// Mirrors redactZodError in packages/ai-relay/src/config.ts; keep the two in lock-step.
export function parseEnv(source: EnvSource): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;
  const failures = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment: ${failures}`);
}
