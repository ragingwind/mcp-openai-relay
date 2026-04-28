// Zod-validated environment loader (#2).
//
// Single point of entry for configuration. Every `lib/*` consumer that needs
// an env var imports from this module — no `process.env` access elsewhere.
// Validation runs once at module load (Vercel cold start) so misconfiguration
// fails fast at boot, not mid-request.
//
// CLAUDE.md §4: error messages MUST never echo any env var value. Failure
// messages are built strictly from `issue.path` + `issue.message` text.

import { z } from "zod";

const DEFAULT_MODEL_ALLOWLIST = ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"] as const;

const csvList = (defaults: readonly string[]) =>
  z
    .string()
    .optional()
    .default(defaults.join(","))
    .transform((csv) =>
      csv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .refine((arr) => arr.length > 0, "must contain at least one entry");

const envSchema = z.object({
  OPENAI_API_KEY: z.string().default(""),
  RELAY_AUTH_TOKEN: z
    .string()
    .refine((s) => Buffer.byteLength(s, "utf8") >= 32, "must be at least 32 bytes"),
  MODEL_ALLOWLIST: csvList(DEFAULT_MODEL_ALLOWLIST),
  MAX_OUTPUT_TOKENS_CEILING: z.coerce.number().int().positive().default(4096),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
});

export type Env = z.infer<typeof envSchema>;

// Permissive env-shaped input. We deliberately do NOT type this as
// `NodeJS.ProcessEnv` because `next/types/global.d.ts` augments that
// interface with a required `NODE_ENV` key — `parseEnv` doesn't consume
// `NODE_ENV` and forcing tests to set it would be noise. `process.env`
// itself satisfies this signature, so the module-level call below still
// type-checks against the real Node process env.
export type EnvSource = Record<string, string | undefined>;

export function parseEnv(source: EnvSource): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;
  // Redacted error: only path + message text from each zod issue. Never include
  // `issue.input` / `issue.received` / any value-derived strings (CLAUDE.md §4).
  const failures = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment: ${failures}`);
}

export const env: Env = parseEnv(process.env);
