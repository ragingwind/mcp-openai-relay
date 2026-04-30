import type { NextConfig } from "next";

// `outputFileTracingRoot`: forces this directory to be the project root so
// `next build`'s file tracing does not climb to a parent worktree's lockfile
// when multiple `pnpm-lock.yaml` files exist higher in the tree.
//
// `turbopack: {}`: Next 16 enables Turbopack by default. Turbopack handles
// TypeScript natively (including the NodeNext `.js → .ts` resolution that
// `verbatimModuleSyntax: true` requires), so no explicit extensionAlias is
// needed — but the empty config block is required to silence the
// "webpack config without turbopack config" build error in Next 16.
const config: NextConfig = {
  outputFileTracingRoot: __dirname,
  output: "standalone",
  turbopack: {},
};

export default config;
