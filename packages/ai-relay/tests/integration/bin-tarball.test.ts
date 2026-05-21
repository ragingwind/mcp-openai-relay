// Integration test for the published-tarball install path of the
// `ai-relay` bin. Packs the SDK, installs it into a temp dir, and
// runs the bin against a local HTTP server that mimics the OpenAI
// Chat Completions endpoint (MSW cannot intercept requests issued
// from a spawned child process).

import { execFileSync, type SpawnOptions, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..", "..");

interface RecordedRequest {
  authorization: string | undefined;
  body: Record<string, unknown>;
}

interface MockServer {
  url: string;
  baseURL: string;
  requests: RecordedRequest[];
  setResponse(handler: (req: RecordedRequest) => { status: number; body: string }): void;
  close(): Promise<void>;
}

async function startMockServer(): Promise<MockServer> {
  const recorded: RecordedRequest[] = [];
  let responder: (req: RecordedRequest) => { status: number; body: string } = () => ({
    status: 200,
    body: defaultSseBody("ok"),
  });

  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = {};
      }
      const recordedReq: RecordedRequest = {
        authorization: req.headers.authorization,
        body,
      };
      recorded.push(recordedReq);
      const out = responder(recordedReq);
      res.statusCode = out.status;
      if (out.status === 200) {
        res.setHeader("content-type", "text/event-stream");
        res.end(out.body);
      } else {
        res.setHeader("content-type", "application/json");
        res.end(out.body);
      }
    });
  });

  await new Promise<void>((resolveListen) => {
    httpServer.listen(0, "127.0.0.1", resolveListen);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    baseURL: `${url}/v1`,
    requests: recorded,
    setResponse(h) {
      responder = h;
    },
    async close() {
      await new Promise<void>((r, j) => httpServer.close((e) => (e ? j(e) : r())));
    },
  };
}

function defaultSseBody(text: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

async function runBin(
  bin: string,
  args: readonly string[],
  opts: { env?: Record<string, string | undefined>; input?: string } = {},
): Promise<SpawnResult> {
  return new Promise((resolveProm, reject) => {
    const spawnOpts: SpawnOptions = {
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    };
    const child = spawn(bin, [...args], spawnOpts);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolveProm({ status: code, stdout, stderr }));
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    } else {
      child.stdin?.end();
    }
  });
}

let scratchDir: string | null = null;
let mcpBinPath: string;
let mock: MockServer;

beforeAll(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), "ai-relay-bin-"));
  // --ignore-scripts: this test exercises the installed-tarball shape, not
  // the prepublish lifecycle. Running scripts would recurse — `npm pack`
  // invokes `prepublishOnly`, which invokes this test, which calls `npm
  // pack` again.
  // --pack-destination: keep the tarball out of SDK_DIR so concurrent
  // `pnpm publish` flows don't race on the same path.
  // Strip dry-run env that the outer process may have set (e.g. when this
  // test runs inside `pnpm publish --dry-run` via prepublishOnly). Without
  // this, the child `npm pack` inherits `npm_config_dry_run=true` and
  // prints the tarball name without writing the file.
  const packEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(packEnv)) {
    if (k === "npm_config_dry_run" || k === "NPM_CONFIG_DRY_RUN") delete packEnv[k];
  }
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", scratchDir], {
    cwd: SDK_DIR,
    stdio: "pipe",
    env: packEnv,
  });
  const tarballs = readdirSync(scratchDir).filter((f) => f.endsWith(".tgz"));
  const firstTarball = tarballs[0];
  if (tarballs.length !== 1 || !firstTarball) {
    throw new Error(
      `Expected 1 tarball after npm pack, got ${tarballs.length}: ${tarballs.join(", ")}`,
    );
  }
  const tarball = join(scratchDir, firstTarball);

  writeFileSync(
    join(scratchDir, "package.json"),
    JSON.stringify({ name: "bin-tarball-test", private: true, type: "module" }),
  );
  execFileSync(
    "npm",
    ["install", "--no-audit", "--no-fund", tarball, "openai@^6", "@anthropic-ai/sdk@^0.96.0"],
    {
      cwd: scratchDir,
      stdio: "pipe",
      env: packEnv,
    },
  );
  mcpBinPath = join(scratchDir, "node_modules", ".bin", "ai-relay");
  if (!existsSync(mcpBinPath)) {
    throw new Error(`ai-relay bin not present at ${mcpBinPath} after install`);
  }
  // The pre-v0.5.0 `ai-relay-mcp` bin must not be installed alongside the
  // new split bins.
  const legacyMcpBin = join(scratchDir, "node_modules", ".bin", "ai-relay-mcp");
  if (existsSync(legacyMcpBin)) {
    throw new Error(`legacy ai-relay-mcp bin should have been removed, found at ${legacyMcpBin}`);
  }
  rmSync(tarball);

  mock = await startMockServer();
}, 180_000);

afterAll(async () => {
  if (mock) await mock.close();
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

describe("ai-relay bin — installed tarball, one-shot CLI mode", () => {
  it("S1: positional plain text with -m flag → exit 0 + JSON on stdout", async () => {
    mock.requests.length = 0;
    mock.setResponse(() => ({ status: 200, body: defaultSseBody("hello world") }));

    const r = await runBin(
      mcpBinPath,
      ["openai", "chat-completions", "-m", "gpt-4o-mini", "ping"],
      {
        env: { AI_RELAY_API_KEY: "test-k", AI_RELAY_BASE_URL: mock.baseURL },
      },
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.isError).toBe(false);
    expect(out.content[0].text).toBe("hello world");
    expect(out.structuredContent.model).toBe("gpt-4o-mini");
  });

  it("S2: plain text without any model source → exit 2; no upstream call", async () => {
    mock.requests.length = 0;
    mock.setResponse(() => ({ status: 200, body: defaultSseBody("ok") }));

    const r = await runBin(mcpBinPath, ["openai", "chat-completions", "ping"], {
      env: { AI_RELAY_API_KEY: "test-k", AI_RELAY_BASE_URL: mock.baseURL },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/model/i);
    expect(mock.requests).toHaveLength(0);
  });

  it("S3: stdin JSON path with -m → upstream sees the parsed messages", async () => {
    mock.requests.length = 0;
    mock.setResponse(() => ({ status: 200, body: defaultSseBody("ok") }));

    const r = await runBin(mcpBinPath, ["openai", "chat-completions", "-m", "gpt-4o-mini"], {
      env: { AI_RELAY_API_KEY: "test-k", AI_RELAY_BASE_URL: mock.baseURL },
      input: '{"messages":[{"role":"user","content":"ping"}]}',
    });
    expect(r.status).toBe(0);
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.body).toMatchObject({
      messages: [{ role: "user", content: "ping" }],
    });
  });

  it("S4: --env file value wins over process env", async () => {
    mock.requests.length = 0;
    mock.setResponse(() => ({ status: 200, body: defaultSseBody("ok") }));
    if (!scratchDir) throw new Error("scratchDir missing");
    const envFile = join(scratchDir, "local.env");
    writeFileSync(envFile, `AI_RELAY_API_KEY=filekey\nAI_RELAY_BASE_URL=${mock.baseURL}\n`);

    const r = await runBin(
      mcpBinPath,
      ["openai", "chat-completions", "-m", "gpt-4o-mini", "--env", envFile, "hi"],
      { env: { AI_RELAY_API_KEY: "systemkey" } },
    );
    expect(r.status).toBe(0);
    expect(mock.requests[0]?.authorization).toBe("Bearer filekey");
  });

  it("S5: --version prints SDK version", async () => {
    const r = await runBin(mcpBinPath, ["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("S6: AI_RELAY_MODEL env resolves model without -m flag", async () => {
    mock.requests.length = 0;
    mock.setResponse(() => ({ status: 200, body: defaultSseBody("ok") }));

    const r = await runBin(mcpBinPath, ["openai", "chat-completions", "ping"], {
      env: {
        AI_RELAY_API_KEY: "test-k",
        AI_RELAY_BASE_URL: mock.baseURL,
        AI_RELAY_MODEL: "gpt-4o-mini",
      },
    });
    expect(r.status).toBe(0);
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.body).toMatchObject({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "ping" }],
    });
  });

  it("T-1: full one-shot round-trip — flag, stdin JSON, env-resolved model", async () => {
    mock.requests.length = 0;
    mock.setResponse(() => ({ status: 200, body: defaultSseBody("hello world") }));

    const r1 = await runBin(
      mcpBinPath,
      ["openai", "chat-completions", "-m", "gpt-4o-mini", "ping"],
      {
        env: { AI_RELAY_API_KEY: "test-k", AI_RELAY_BASE_URL: mock.baseURL },
      },
    );
    expect(r1.status).toBe(0);
    const out1 = JSON.parse(r1.stdout.trim());
    expect(out1.isError).toBe(false);
    expect(out1.content[0].text).toBe("hello world");

    mock.requests.length = 0;
    mock.setResponse(() => ({ status: 200, body: defaultSseBody("ok") }));
    const r2 = await runBin(mcpBinPath, ["openai", "chat-completions", "-m", "gpt-4o-mini"], {
      env: { AI_RELAY_API_KEY: "test-k", AI_RELAY_BASE_URL: mock.baseURL },
      input: '{"messages":[{"role":"user","content":"hi"}]}',
    });
    expect(r2.status).toBe(0);
    expect(mock.requests[0]?.body).toMatchObject({
      messages: [{ role: "user", content: "hi" }],
    });

    mock.requests.length = 0;
    const r3 = await runBin(mcpBinPath, ["openai", "chat-completions", "plain-text-input"], {
      env: {
        AI_RELAY_API_KEY: "test-k",
        AI_RELAY_BASE_URL: mock.baseURL,
        AI_RELAY_MODEL: "gpt-4o-mini",
      },
    });
    expect(r3.status).toBe(0);
    expect(mock.requests[0]?.body).toMatchObject({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "plain-text-input" }],
    });
  });
});

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpSessionResult {
  status: number | null;
  responses: JsonRpcResponse[];
  stderr: string;
}

async function runMcpSession(
  requests: readonly object[],
  opts: {
    env?: Record<string, string | undefined>;
    args?: readonly string[];
    expectStartupFailure?: boolean;
  } = {},
): Promise<McpSessionResult> {
  return new Promise((resolveProm, reject) => {
    const spawnOpts: SpawnOptions = {
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    };
    const child = spawn(mcpBinPath, [...(opts.args ?? [])], spawnOpts);
    const responses: JsonRpcResponse[] = [];
    let stdoutBuf = "";
    let stderr = "";
    let closed = false;

    const expectedResponses = requests.filter(
      (r) => "id" in r && (r as { id: unknown }).id !== undefined,
    ).length;

    const closeStdinSoon = () => {
      if (closed) return;
      closed = true;
      child.stdin?.end();
    };

    child.stdout?.on("data", (c: Buffer) => {
      stdoutBuf += c.toString("utf8");
      for (;;) {
        const nl = stdoutBuf.indexOf("\n");
        if (nl === -1) break;
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          responses.push(JSON.parse(line) as JsonRpcResponse);
        } catch {
          // ignore non-JSON lines (e.g., diagnostics)
        }
        if (responses.length >= expectedResponses) closeStdinSoon();
      }
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolveProm({ status: code, responses, stderr }));

    for (const req of requests) {
      child.stdin?.write(`${JSON.stringify(req)}\n`);
    }
    if (opts.expectStartupFailure || expectedResponses === 0) closeStdinSoon();
  });
}

const initRequest = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "vitest", version: "0" },
  },
};
const initializedNotification = {
  jsonrpc: "2.0" as const,
  method: "notifications/initialized",
};

describe("ai-relay bin — installed tarball, MCP stdio mode (openai provider positional)", () => {
  it("A1: initialize handshake returns protocolVersion + serverInfo", async () => {
    const r = await runMcpSession([initRequest, initializedNotification], {
      args: ["openai", "-m", "gpt-4o-mini"],
      env: { AI_RELAY_API_KEY: "test-k", AI_RELAY_BASE_URL: mock.baseURL },
    });
    expect(r.status).toBe(0);
    expect(r.responses).toHaveLength(1);
    const initRes = r.responses[0]?.result as {
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
      capabilities?: { tools?: unknown };
    };
    expect(initRes?.protocolVersion).toBe("2024-11-05");
    expect(initRes?.serverInfo?.name).toBe("ai-relay");
    expect(initRes?.capabilities?.tools).toBeDefined();
  });

  it("A2: tools/list returns chat-completions + responses with input schema (messages-only)", async () => {
    const r = await runMcpSession(
      [initRequest, initializedNotification, { jsonrpc: "2.0", id: 2, method: "tools/list" }],
      {
        args: ["openai", "-m", "gpt-4o-mini"],
        env: { AI_RELAY_API_KEY: "test-k", AI_RELAY_BASE_URL: mock.baseURL },
      },
    );
    expect(r.status).toBe(0);
    expect(r.responses).toHaveLength(2);
    const listRes = r.responses[1]?.result as {
      tools?: Array<{
        name: string;
        inputSchema?: { required?: string[]; properties?: Record<string, unknown> };
      }>;
    };
    expect(listRes?.tools).toHaveLength(2);
    const names = (listRes?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(["chat-completions", "responses"]);
    for (const tool of listRes?.tools ?? []) {
      expect(tool.inputSchema?.required).toEqual(["messages"]);
      expect(tool.inputSchema?.properties).not.toHaveProperty("model");
    }
  });

  it("B1: tools/call chat-completions forwards messages and returns assistant text", async () => {
    mock.requests.length = 0;
    mock.setResponse(() => ({ status: 200, body: defaultSseBody("pong") }));

    const r = await runMcpSession(
      [
        initRequest,
        initializedNotification,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "chat-completions",
            arguments: {
              messages: [{ role: "user", content: "ping" }],
            },
          },
        },
      ],
      {
        args: ["openai", "-m", "gpt-4o-mini"],
        env: { AI_RELAY_API_KEY: "test-k", AI_RELAY_BASE_URL: mock.baseURL },
      },
    );
    expect(r.status).toBe(0);
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.authorization).toBe("Bearer test-k");
    expect(mock.requests[0]?.body).toMatchObject({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "ping" }],
    });
    const callRes = r.responses[1]?.result as {
      content?: Array<{ type: string; text: string }>;
      structuredContent?: { model?: string };
      isError?: boolean;
    };
    expect(callRes?.isError).toBe(false);
    expect(callRes?.content?.[0]?.text).toBe("pong");
    expect(callRes?.structuredContent?.model).toBe("gpt-4o-mini");
  });

  it("C1: bare invocation (no provider) → exit 2 + usage on stderr; no upstream call", async () => {
    mock.requests.length = 0;
    const r = await runMcpSession([], {
      args: [],
      expectStartupFailure: true,
      env: { AI_RELAY_API_KEY: "test-k", AI_RELAY_BASE_URL: mock.baseURL },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("<provider>");
    expect(r.stderr).toContain("usage: ai-relay <provider>");
    expect(mock.requests).toHaveLength(0);
  });

  it("C2: unknown provider → exit 2; no upstream call", async () => {
    mock.requests.length = 0;
    const r = await runMcpSession([], {
      args: ["gemini"],
      expectStartupFailure: true,
      env: { AI_RELAY_API_KEY: "test-k", AI_RELAY_BASE_URL: mock.baseURL },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown provider: gemini");
    expect(mock.requests).toHaveLength(0);
  });

  it("D1: missing AI_RELAY_API_KEY → exits 2 with stderr message; no upstream call", async () => {
    mock.requests.length = 0;
    const r = await runMcpSession([initRequest], {
      args: ["openai"],
      env: { AI_RELAY_API_KEY: undefined, AI_RELAY_BASE_URL: mock.baseURL },
      expectStartupFailure: true,
    });
    expect(r.status).toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(mock.requests).toHaveLength(0);
  });

  it("N1: --version prints SDK version (no MCP server started)", async () => {
    const r = await runMcpSession([], { args: ["--version"] });
    expect(r.status).toBe(0);
  });

  it("D2: unknown flag exits 2", async () => {
    const r = await runMcpSession([], {
      args: ["openai", "--bogus"],
      expectStartupFailure: true,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown flag");
  });

  it("V1: --verbose emits mcp-rpc-in/out + stage lines on stderr; stdout stays valid JSON-RPC", async () => {
    mock.requests.length = 0;
    const r = await runMcpSession(
      [initRequest, initializedNotification, { jsonrpc: "2.0", id: 2, method: "tools/list" }],
      {
        args: ["openai", "-m", "gpt-4o-mini", "--verbose"],
        env: { AI_RELAY_API_KEY: "test-k", AI_RELAY_BASE_URL: mock.baseURL },
      },
    );
    expect(r.status).toBe(0);
    expect(r.responses).toHaveLength(2);
    expect(r.stderr).toContain("] mcp-server-ready:");
    expect(r.stderr).toContain("] mcp-rpc-in:");
    expect(r.stderr).toContain("] mcp-rpc-out:");
    expect(r.stderr).toMatch(/^\[ai-relay\] /m);
    expect(r.stderr).not.toMatch(/^\[verbose \d{4}-/m);
  });

  it("V2: AI_RELAY_VERBOSE=1 enables verbose without the flag", async () => {
    const r = await runMcpSession([initRequest, initializedNotification], {
      args: ["openai", "-m", "gpt-4o-mini"],
      env: {
        AI_RELAY_API_KEY: "test-k",
        AI_RELAY_BASE_URL: mock.baseURL,
        AI_RELAY_VERBOSE: "1",
      },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("] argv:");
    expect(r.stderr).toContain("] mcp-rpc-in:");
  });

  it("V3: --verbose redacts the AI_RELAY_API_KEY in stderr", async () => {
    const canary = "sk-mcp-leak-canary-9999";
    const r = await runMcpSession([initRequest, initializedNotification], {
      args: ["openai", "-m", "gpt-4o-mini", "--verbose"],
      env: { AI_RELAY_API_KEY: canary, AI_RELAY_BASE_URL: mock.baseURL },
    });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain(canary);
    expect(r.stderr).toContain("***redacted(");
  });

  it("V4: --verbose tools/call emits messages content + upstream text verbatim (body disclosure trade-off)", async () => {
    mock.requests.length = 0;
    const upstreamMarker = "upstream-body-canary-MCP";
    mock.setResponse(() => ({ status: 200, body: defaultSseBody(upstreamMarker) }));
    const userMarker = "user-prompt-canary-MCP";
    const r = await runMcpSession(
      [
        initRequest,
        initializedNotification,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "chat-completions",
            arguments: {
              messages: [{ role: "user", content: userMarker }],
            },
          },
        },
      ],
      {
        args: ["openai", "-m", "gpt-4o-mini", "--verbose"],
        env: { AI_RELAY_API_KEY: "test-k", AI_RELAY_BASE_URL: mock.baseURL },
      },
    );
    expect(r.status).toBe(0);
    expect(r.responses).toHaveLength(2);
    // Outgoing JSON-RPC must still carry the upstream text on stdout
    const callRes = r.responses[1]?.result as {
      content?: Array<{ text: string }>;
    };
    expect(callRes?.content?.[0]?.text).toBe(upstreamMarker);
    // Verbose now emits both the user prompt AND the accumulated upstream text
    // (operator opted into --verbose; secrets remain redacted independently).
    expect(r.stderr).toContain(userMarker);
    expect(r.stderr).toContain(upstreamMarker);
  });
});
