// Hono entry point — the MCP relay HTTP server.
//
// Consumes the framework-agnostic primitives published as `ai-relay`
// and wires them into mcp-handler. mcp-handler v1.1+ is Web-Request native
// (`(request: Request) => Promise<Response>`), so Hono's `c.req.raw` (a
// standard `Request`) hands off cleanly to the wrapped handler — no shim
// needed.
//
// Wiring layers, outermost first:
//   1. Hono app — exposes `/healthz` (liveness, no auth) and `/api/mcp`.
//   2. `withMcpAuth(handler, ...)` — bearer-token gate at `/api/mcp`.
//      Unauthenticated requests get 401 + `WWW-Authenticate: Bearer ...`
//      automatically.
//   3. `createMcpHandler((server) => registerOpenAIProvider(server, ...))` —
//      registers the `chat-completions` and `responses` tools on each request boundary.
//
// `app` is exported so integration tests can call `app.fetch(request)`
// without booting an actual HTTP listener. The `import.meta.url` guard
// at the bottom only starts `serve(...)` when this file is executed
// directly (not when imported by tests or other modules).

import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { verifyBearer } from "ai-relay";
import { createVerboseLogger, isVerboseEnv } from "ai-relay/logger";
import { registerOpenAIProvider } from "ai-relay/openai";
import { Hono } from "hono";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { parseEnv } from "./env.js";

const env = parseEnv(process.env);

const logger = createVerboseLogger({
  enabled: isVerboseEnv(process.env),
  stream: process.stderr,
});

const handler = createMcpHandler(
  (server) => {
    registerOpenAIProvider(server, {
      apiKey: env.AI_RELAY_API_KEY,
      ...(env.AI_RELAY_BASE_URL ? { baseURL: env.AI_RELAY_BASE_URL } : {}),
      model: env.AI_RELAY_MODEL,
      ...(env.AI_RELAY_TEMPERATURE !== undefined ? { temperature: env.AI_RELAY_TEMPERATURE } : {}),
      ...(env.AI_RELAY_MAX_TOKENS !== undefined ? { max_tokens: env.AI_RELAY_MAX_TOKENS } : {}),
      ...(env.AI_RELAY_TOP_P !== undefined ? { top_p: env.AI_RELAY_TOP_P } : {}),
      ...(env.AI_RELAY_STOP !== undefined ? { stop: env.AI_RELAY_STOP } : {}),
      ...(env.AI_RELAY_REASONING_EFFORT !== undefined
        ? { reasoning_effort: env.AI_RELAY_REASONING_EFFORT }
        : {}),
      requestTimeoutMs: env.AI_RELAY_REQUEST_TIMEOUT_MS,
      ...(logger.enabled ? { logger } : {}),
    });
  },
  {},
  {
    // mcp-handler matches against the URL pathname starting from `basePath`.
    // Our route lives at `/api/mcp` so matching `basePath: "/api"` is required
    // for mcp-handler to accept the request.
    basePath: "/api",
  },
);

const wrapped = withMcpAuth(
  handler,
  (_req, token) => {
    if (typeof token !== "string") return undefined;
    if (!verifyBearer(token, env.AI_RELAY_AUTH_TOKEN)) return undefined;
    // `token` is the validated bearer; echoing it back to the SDK lets
    // downstream handlers attribute calls without re-parsing the header.
    return { token, clientId: "shared-secret", scopes: ["openai:chat"] };
  },
  {
    required: true,
    requiredScopes: ["openai:chat"],
  },
);

export const app = new Hono();

app.get("/healthz", (c) => c.text("ok"));

// Single MCP route — accept all standard methods and delegate to the
// mcp-handler wrapped handler. We use Hono's `app.all` so the same
// adapter handles GET (SSE upgrade), POST (Streamable HTTP), and DELETE
// (session teardown) per the MCP transport contract.
app.all("/api/mcp", (c) => wrapped(c.req.raw));

// Start the listener only when this file is executed directly (e.g.
// `node dist/index.js` or `tsx watch src/index.ts`). Tests that import
// `app` get the handler without binding a port.
const isDirectRun =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const server = serve({ fetch: app.fetch, port: env.AI_RELAY_PORT }, (info) => {
    // Single-line startup log — no secrets, only port + endpoint.
    console.log(`mcp-ai-relay listening on http://localhost:${info.port}/api/mcp`);
  });

  // Container orchestrators (Docker, Kubernetes) send SIGTERM before SIGKILL.
  // Without an explicit handler the process is killed at the grace-period
  // boundary (Docker default 10 s) and exits 137. Closing the listener stops
  // accepting new connections and lets in-flight requests finish.
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
