// MCP route entry point (#5).
//
// Single route per ARCHITECTURE.md §5 / CLAUDE.md §5. The Next.js dynamic
// `[transport]` segment lets `mcp-handler` route by transport type (Streamable
// HTTP for v1; SSE deprecated upstream).
//
// Wiring layers, outermost first:
//   1. `withMcpAuth(handler, verifyToken, { required: true, requiredScopes })`
//      — Bearer-token gate. Unauthenticated requests get 401 +
//        `WWW-Authenticate: Bearer ...` + a `/.well-known/oauth-protected-resource`
//        discovery URL pointer. Authenticated requests reach the inner handler.
//   2. `createMcpHandler((server) => server.tool(...))` — registers exactly one
//      tool: `openai_chat` (v1 scope). Routes JSON-RPC `tools/list` and
//      `tools/call` internally.
//
// CLAUDE.md §9 invariants enforced here:
//   • `withMcpAuth` wrapper is applied — without it, the route would accept
//     unauthenticated traffic.
//   • `export const maxDuration = 300` — defense in depth with vercel.json,
//     so the route does not silently fall back to the dashboard default.
//   • `export const runtime = "nodejs"` — Edge runtime would hit the 25s TTFB
//     cap and break streaming chat completions.

import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { verifyToken } from "../../../lib/auth.js";
import { openaiChatTool } from "../../../lib/tools/openai-chat.js";

const handler = createMcpHandler(
  (server) => {
    // `server.tool(name, description, paramsSchema, cb)` — the schema
    // parameter is the Zod RawShape (i.e. `inputSchema.shape`), not the full
    // Zod object. mcp-handler reconstructs the schema internally; passing
    // the shape is the documented signature in @modelcontextprotocol/sdk's
    // McpServer.
    server.tool(
      openaiChatTool.name,
      openaiChatTool.description,
      openaiChatTool.inputSchema.shape,
      (args, extra) => openaiChatTool.handler(args, extra),
    );
  },
  {},
  {
    // Our route is `app/api/[transport]/route.ts` so Next maps the URL
    // pathname to `/api/<transport>` (e.g. `/api/mcp`). Without `basePath`,
    // mcp-handler compares against `/mcp` only and rejects every request
    // with "url not matched". Setting `basePath: "/api"` derives
    // `/api/mcp`, `/api/sse`, and `/api/message` — matching what Next.js
    // serves.
    basePath: "/api",
  },
);

const wrapped = withMcpAuth(handler, verifyToken, {
  required: true,
  requiredScopes: ["openai:chat"],
});

export const runtime = "nodejs";
export const maxDuration = 300;

export { wrapped as GET, wrapped as POST, wrapped as DELETE };
