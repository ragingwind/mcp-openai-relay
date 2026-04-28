import type { NextConfig } from "next";

// Pin workspace root + teach webpack the NodeNext `.js → .ts` alias.
//
// `outputFileTracingRoot`: forces this directory to be the project root so
// `next build`'s file tracing does not climb to a parent worktree's lockfile
// when multiple `pnpm-lock.yaml` files exist higher in the tree.
//
// `webpack.resolve.extensionAlias`: tsconfig is `module: "NodeNext"` with
// `verbatimModuleSyntax`, so source files MUST import with the `.js` suffix
// (`./auth.js`) even though the file on disk is `./auth.ts`. The TypeScript
// compiler resolves this transparently, but webpack does not — without an
// alias, `Module not found` blocks `next build`. The alias maps every `.js`
// import request to its `.ts` / `.tsx` source, mirroring `tsc`'s behavior.
const config: NextConfig = {
  outputFileTracingRoot: __dirname,
  webpack: (webpackConfig) => {
    webpackConfig.resolve = webpackConfig.resolve ?? {};
    webpackConfig.resolve.extensionAlias = {
      ...webpackConfig.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return webpackConfig;
  },
};

export default config;
