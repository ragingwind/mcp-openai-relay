import { defineConfig } from "vitest/config";

// Project-level defaults. Per-project (unit / integration) configuration lives
// in `vitest.workspace.ts` so `pnpm test:unit` and `pnpm test:integration`
// can resolve the named projects via Vitest 2's workspace API.
export default defineConfig({
  test: {
    environment: "node",
  },
});
