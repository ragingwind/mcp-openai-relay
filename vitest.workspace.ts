import { defineWorkspace } from "vitest/config";

// Vitest 2 uses the workspace API (Vitest 3's `projects` is unavailable on
// the `^2` line pinned in ARCHITECTURE.md §6 / plan OQ-5). The two named
// projects below back `pnpm test:unit` and `pnpm test:integration`.
//
// `setupFiles` registers `tests/setup-env.ts` in BOTH projects so that any
// test that transitively imports `lib/env.ts` has minimal valid `process.env`
// values seeded before module-level `parseEnv(process.env)` runs (per OQ-5).
export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: ["tests/unit/**/*.test.ts"],
      environment: "node",
      setupFiles: ["./tests/setup-env.ts"],
    },
  },
  {
    test: {
      name: "integration",
      include: ["tests/integration/**/*.test.ts"],
      environment: "node",
      setupFiles: ["./tests/setup-env.ts"],
    },
  },
]);
