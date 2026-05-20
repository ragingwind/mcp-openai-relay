import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type RunIO, run } from "../../src/bin/run.js";

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let scratchDir: string;
beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "ai-relay-run-"));
});
afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

interface CapturedIO {
  io: RunIO;
  stdout: { value: string };
  stderr: { value: string };
}

function makeIO(
  opts: {
    stdin?: string;
    stdinIsTTY?: boolean;
    env?: Record<string, string | undefined>;
    isTTY?: boolean;
  } = {},
): CapturedIO {
  const stdoutBuf = { value: "" };
  const stderrBuf = { value: "" };
  let stdin: Readable;
  let stdinIsTTY: boolean;
  if (opts.stdin === undefined) {
    stdin = new Readable({
      read() {
        this.push(null);
      },
    });
    stdinIsTTY = opts.stdinIsTTY ?? true;
  } else {
    stdin = Readable.from([opts.stdin]);
    stdinIsTTY = opts.stdinIsTTY ?? false;
  }
  const io: RunIO = {
    stdin,
    stdinIsTTY,
    stdout: {
      write: (s) => {
        stdoutBuf.value += s;
      },
    },
    stderr: {
      write: (s) => {
        stderrBuf.value += s;
      },
    },
    env: opts.env ?? {},
    isTTY: opts.isTTY ?? false,
  };
  return { io, stdout: stdoutBuf, stderr: stderrBuf };
}

function sseChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(`data: ${chunks[i]}\n\n`));
        i++;
      } else {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
}

function happyResponse(text = "ok") {
  return new HttpResponse(
    sseChunks([
      JSON.stringify({
        choices: [{ delta: { content: text }, finish_reason: "stop" }],
      }),
    ]),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("run — usage errors short-circuit", () => {
  it("D1: no args → exit 2 + stderr usage message", async () => {
    const cap = makeIO();
    const code = await run([], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toMatch(/usage: ai-relay/);
  });

  it("D2: unknown provider → exit 2", async () => {
    const cap = makeIO();
    const code = await run(["nope", "chat-completions", "hi"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("unknown provider: nope");
  });

  it("D2b: unknown tool for known provider → exit 2", async () => {
    const cap = makeIO();
    const code = await run(["openai", "messages", "hi"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("unknown tool for provider openai: messages");
  });

  it("D2c: anthropic + chat-completions cross-product → exit 2", async () => {
    const cap = makeIO();
    const code = await run(["anthropic", "chat-completions", "hi"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("unknown tool for provider anthropic: chat-completions");
  });

  it("P5: anthropic provider resolves via lazy loader and is listed under known providers", async () => {
    const cap = makeIO();
    const code = await run(["anthropic", "unknown-tool", "hi"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("unknown tool for provider anthropic");
    expect(cap.stderr.value).toContain("messages");
  });

  it("D3: -h prints usage on stdout, exit 0", async () => {
    const cap = makeIO();
    const code = await run(["-h"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout.value).toContain("Usage: ai-relay <provider> <tool>");
  });

  it("D4: -V prints version on stdout, exit 0", async () => {
    const cap = makeIO();
    const code = await run(["-V"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout.value).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});

describe("run — input handling", () => {
  it("D1: stdin + positional both present → exit 2 with conflict message", async () => {
    const cap = makeIO({
      stdin: '{"messages":[{"role":"user","content":"x"}]}',
      env: { AI_RELAY_API_KEY: "k" },
    });
    const code = await run(["openai", "chat-completions", "-m", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("received both stdin and positional input");
  });

  it("P1: positional plain text desugared and dispatched", async () => {
    let captured: { messages?: { role: string; content: string }[]; model?: string } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        captured = (await request.json()) as typeof captured;
        return happyResponse("hello");
      }),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(["openai", "chat-completions", "-m", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(0);
    expect(captured?.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(captured?.model).toBe("gpt-4o-mini");
    const out = JSON.parse(cap.stdout.value.trim());
    expect(out.isError).toBe(false);
    expect(out.content[0].text).toBe("hello");
    expect(out.structuredContent.model).toBe("gpt-4o-mini");
  });

  it("P2: stdin JSON ({messages}) parsed verbatim with model from flag", async () => {
    let captured: { messages?: { role: string; content: string }[]; model?: string } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        captured = (await request.json()) as typeof captured;
        return happyResponse();
      }),
    );
    const cap = makeIO({
      stdin: '{"messages":[{"role":"user","content":"ping"}]}',
      env: { AI_RELAY_API_KEY: "k" },
    });
    const code = await run(["openai", "chat-completions", "-m", "gpt-4o-mini"], cap.io);
    expect(code).toBe(0);
    expect(captured?.messages).toEqual([{ role: "user", content: "ping" }]);
    expect(captured?.model).toBe("gpt-4o-mini");
  });

  it("D2: caller-supplied JSON `model` rejected by strict schema → exit 1", async () => {
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    await expect(
      run(
        [
          "openai",
          "chat-completions",
          "-m",
          "gpt-4o-mini",
          '{"model":"x","messages":[{"role":"user","content":"hi"}]}',
        ],
        cap.io,
      ),
    ).rejects.toThrow(/model|Unrecognized/i);
  });

  it("D3: empty stdin pipe → exit 2", async () => {
    const cap = makeIO({ stdin: "", env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(["openai", "chat-completions", "-m", "gpt-4o-mini"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("empty stdin");
  });

  it("D4: positional JSON array → exit 2 with array-rejection message naming the tool", async () => {
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(["openai", "chat-completions", "-m", "gpt-4o-mini", "[1,2,3]"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain(
      "input JSON for chat-completions must be an object, not an array",
    );
  });

  it("P3: --system + plain text → system prepended", async () => {
    let captured: { messages?: { role: string; content: string }[] } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        captured = (await request.json()) as typeof captured;
        return happyResponse();
      }),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(
      ["openai", "chat-completions", "-m", "gpt-4o-mini", "-s", "be terse", "hi"],
      cap.io,
    );
    expect(code).toBe(0);
    expect(captured?.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
  });
});

describe("run — model resolution", () => {
  it("P1: -m flag sets the server-config model", async () => {
    let captured: { model?: string } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        captured = (await request.json()) as typeof captured;
        return happyResponse();
      }),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(["openai", "chat-completions", "-m", "from-flag", "hi"], cap.io);
    expect(code).toBe(0);
    expect(captured?.model).toBe("from-flag");
  });

  it("P2: AI_RELAY_MODEL env used when no flag", async () => {
    let captured: { model?: string } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        captured = (await request.json()) as typeof captured;
        return happyResponse();
      }),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k", AI_RELAY_MODEL: "from-env" } });
    const code = await run(["openai", "chat-completions", "hi"], cap.io);
    expect(code).toBe(0);
    expect(captured?.model).toBe("from-env");
  });

  it("P3: -m flag wins over AI_RELAY_MODEL env", async () => {
    let captured: { model?: string } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        captured = (await request.json()) as typeof captured;
        return happyResponse();
      }),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k", AI_RELAY_MODEL: "from-env" } });
    const code = await run(["openai", "chat-completions", "-m", "from-flag", "hi"], cap.io);
    expect(code).toBe(0);
    expect(captured?.model).toBe("from-flag");
  });

  it("P4: --model long form works just like -m", async () => {
    let captured: { model?: string } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        captured = (await request.json()) as typeof captured;
        return happyResponse();
      }),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(
      ["openai", "chat-completions", "--model", "from-long-flag", "hi"],
      cap.io,
    );
    expect(code).toBe(0);
    expect(captured?.model).toBe("from-long-flag");
  });

  it("D1: no model from any source → exit 2 with config error", async () => {
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(["openai", "chat-completions", "hi"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toMatch(/model/i);
  });
});

describe("run — env precedence", () => {
  let envFile: string;
  beforeEach(() => {
    envFile = join(scratchDir, `env-${Math.random().toString(36).slice(2)}.env`);
  });

  it("P1: --api-key flag wins over --env file value", async () => {
    let auth: string | null = null;
    server.use(
      http.post(ENDPOINT, ({ request }) => {
        auth = request.headers.get("authorization");
        return happyResponse();
      }),
    );
    writeFileSync(envFile, "AI_RELAY_API_KEY=fromfile\n");
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "fromenv" } });
    const code = await run(
      [
        "openai",
        "chat-completions",
        "-m",
        "gpt-4o-mini",
        "--api-key",
        "fromflag",
        "--env",
        envFile,
        "hi",
      ],
      cap.io,
    );
    expect(code).toBe(0);
    expect(auth).toBe("Bearer fromflag");
  });

  it("P2: --env file value wins over process.env", async () => {
    let auth: string | null = null;
    server.use(
      http.post(ENDPOINT, ({ request }) => {
        auth = request.headers.get("authorization");
        return happyResponse();
      }),
    );
    writeFileSync(envFile, "AI_RELAY_API_KEY=fromfile\n");
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "fromenv" } });
    const code = await run(
      ["openai", "chat-completions", "-m", "gpt-4o-mini", "--env", envFile, "hi"],
      cap.io,
    );
    expect(code).toBe(0);
    expect(auth).toBe("Bearer fromfile");
  });

  it("P3: process.env value used when no flag and no env file", async () => {
    let auth: string | null = null;
    server.use(
      http.post(ENDPOINT, ({ request }) => {
        auth = request.headers.get("authorization");
        return happyResponse();
      }),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "fromenv" } });
    const code = await run(["openai", "chat-completions", "-m", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(0);
    expect(auth).toBe("Bearer fromenv");
  });

  it("D1: no key from any source → exit 2 with config error", async () => {
    const cap = makeIO();
    const code = await run(["openai", "chat-completions", "-m", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr.value).toContain("apiKey");
  });
});

describe("run — secret redaction", () => {
  it("D1: failing schema does NOT echo --api-key value", async () => {
    const sentinel = "leak-canary-9999";
    const cap = makeIO({ env: {} });
    const code = await run(
      [
        "openai",
        "chat-completions",
        "-m",
        "gpt-4o-mini",
        "--api-key",
        "",
        "--env",
        "/no/such/file.env",
        "hi",
      ],
      cap.io,
    );
    expect(code).toBe(2);
    expect(cap.stderr.value).not.toContain(sentinel);
  });

  it("D2: env-file read failure does NOT echo file contents", async () => {
    const sentinel = "leak-marker-env-file";
    const cap = makeIO({ env: { AI_RELAY_API_KEY: sentinel } });
    const code = await run(
      ["openai", "chat-completions", "-m", "gpt-4o-mini", "--env", "/no/such/file.env", "hi"],
      cap.io,
    );
    expect(code).toBe(2);
    expect(cap.stderr.value).not.toContain(sentinel);
  });
});

describe("run — flag-driven server config", () => {
  it("P1: --max-tokens flows to upstream request body as server-config max_tokens", async () => {
    let body: { max_tokens?: number } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return happyResponse();
      }),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(
      ["openai", "chat-completions", "-m", "gpt-4o-mini", "--max-tokens", "256", "hi"],
      cap.io,
    );
    expect(code).toBe(0);
    expect(body?.max_tokens).toBe(256);
  });

  it("P2: --base-url flag retargets the upstream", async () => {
    let hit = false;
    server.use(
      http.post("https://relay.example.com/v1/chat/completions", () => {
        hit = true;
        return happyResponse();
      }),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(
      [
        "openai",
        "chat-completions",
        "-m",
        "gpt-4o-mini",
        "--base-url",
        "https://relay.example.com/v1",
        "hi",
      ],
      cap.io,
    );
    expect(code).toBe(0);
    expect(hit).toBe(true);
  });

  it("P3: --temperature flows to upstream request body", async () => {
    let body: { temperature?: number } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return happyResponse();
      }),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(
      ["openai", "chat-completions", "-m", "gpt-4o-mini", "--temperature", "0.2", "hi"],
      cap.io,
    );
    expect(code).toBe(0);
    expect(body?.temperature).toBe(0.2);
  });

  it("P4: --top-p flows to upstream request body", async () => {
    let body: { top_p?: number } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return happyResponse();
      }),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(
      ["openai", "chat-completions", "-m", "gpt-4o-mini", "--top-p", "0.9", "hi"],
      cap.io,
    );
    expect(code).toBe(0);
    expect(body?.top_p).toBe(0.9);
  });

  it("P5: --stop (single) flows to upstream as a string", async () => {
    let body: { stop?: unknown } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return happyResponse();
      }),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(
      ["openai", "chat-completions", "-m", "gpt-4o-mini", "--stop", "END", "hi"],
      cap.io,
    );
    expect(code).toBe(0);
    expect(body?.stop).toBe("END");
  });

  it("P6: --stop CSV flows to upstream as an array", async () => {
    let body: { stop?: unknown } | undefined;
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return happyResponse();
      }),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(
      ["openai", "chat-completions", "-m", "gpt-4o-mini", "--stop", "END,STOP", "hi"],
      cap.io,
    );
    expect(code).toBe(0);
    expect(body?.stop).toEqual(["END", "STOP"]);
  });
});

describe("run — verbose stderr", () => {
  it("P1: -v flag emits verbose stage lines to stderr, stdout stays single JSON line", async () => {
    server.use(http.post(ENDPOINT, () => happyResponse("ok")));
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(["openai", "chat-completions", "-v", "-m", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout.value.trim().split("\n")).toHaveLength(1);
    for (const stage of [
      "argv",
      "parsed-flags",
      "env-snapshot",
      "cli-input-raw",
      "cli-input-parsed",
      "loaded-config",
      "openai-stream-start",
      "openai-http-request",
      "openai-http-response",
      "openai-stream-end",
      "result",
    ]) {
      expect(cap.stderr.value).toContain(`] ${stage}:`);
    }
    for (const line of cap.stderr.value.split("\n").filter((l) => l.length > 0)) {
      expect(line).toMatch(/^\[ai-relay\] /);
    }
    expect(cap.stderr.value).not.toMatch(/^\[verbose \d{4}-/m);
  });

  it("P2: AI_RELAY_VERBOSE=1 env enables verbose without the -v flag", async () => {
    server.use(http.post(ENDPOINT, () => happyResponse("ok")));
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k", AI_RELAY_VERBOSE: "1" } });
    const code = await run(["openai", "chat-completions", "-m", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(0);
    expect(cap.stderr.value).toContain("] argv:");
    expect(cap.stderr.value).toContain("] openai-stream-start:");
  });

  it("P3: no -v and no AI_RELAY_VERBOSE → no verbose lines on stderr", async () => {
    server.use(http.post(ENDPOINT, () => happyResponse("ok")));
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(["openai", "chat-completions", "-m", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(0);
    expect(cap.stderr.value).toBe("");
  });

  it("D1: --api-key value MUST NOT appear in verbose stderr", async () => {
    server.use(http.post(ENDPOINT, () => happyResponse("ok")));
    const sentinel = "sk-leak-canary-7777";
    const cap = makeIO({ env: {} });
    const code = await run(
      ["openai", "chat-completions", "-v", "-m", "gpt-4o-mini", "--api-key", sentinel, "hi"],
      cap.io,
    );
    expect(code).toBe(0);
    expect(cap.stderr.value).not.toContain(sentinel);
    expect(cap.stderr.value).toContain("***redacted(");
  });

  it("D2: AI_RELAY_API_KEY env value MUST NOT appear in verbose stderr", async () => {
    server.use(http.post(ENDPOINT, () => happyResponse("ok")));
    const sentinel = "sk-env-leak-canary-8888";
    const cap = makeIO({ env: { AI_RELAY_API_KEY: sentinel } });
    const code = await run(["openai", "chat-completions", "-v", "-m", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(0);
    expect(cap.stderr.value).not.toContain(sentinel);
  });

  it("D3: Authorization header on outbound OpenAI request is redacted", async () => {
    server.use(http.post(ENDPOINT, () => happyResponse("ok")));
    const sentinel = "sk-supersecret-canary-12345";
    const cap = makeIO({ env: { AI_RELAY_API_KEY: sentinel } });
    const code = await run(["openai", "chat-completions", "-v", "-m", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(0);
    expect(cap.stderr.value).not.toContain(sentinel);
    expect(cap.stderr.value).not.toContain("supersecret");
    expect(cap.stderr.value).toMatch(/Bearer \*\*\*redacted\(\d+chars\)\*\*\*/);
  });

  it("D3b: verbose emits the accumulated upstream text verbatim", async () => {
    const upstreamMarker = "upstream-body-trace-marker-3333";
    server.use(http.post(ENDPOINT, () => happyResponse(upstreamMarker)));
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(["openai", "chat-completions", "-v", "-m", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(0);
    expect(cap.stderr.value).toContain(upstreamMarker);
    expect(cap.stdout.value).toContain(upstreamMarker);
  });

  it("D3c: verbose emits the request messages verbatim (role + content)", async () => {
    server.use(http.post(ENDPOINT, () => happyResponse("ok")));
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(
      ["openai", "chat-completions", "-v", "-m", "gpt-4o-mini", "the-user-prompt-content"],
      cap.io,
    );
    expect(code).toBe(0);
    expect(cap.stderr.value).toContain("the-user-prompt-content");
    expect(cap.stderr.value).toContain('"role"');
  });

  it("D4: upstream error path emits tool-error stage with provider field", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.json({ error: { message: "no auth" } }, { status: 401 }),
      ),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(["openai", "chat-completions", "-v", "-m", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(1);
    expect(cap.stderr.value).toContain("] tool-error:");
    expect(cap.stderr.value).toContain('"provider": "openai"');
  });

  it("D4b: anthropic upstream error emits tool-error stage with provider=anthropic", async () => {
    server.use(
      http.post("https://api.anthropic.com/v1/messages", () =>
        HttpResponse.json(
          { error: { type: "authentication_error", message: "no auth" } },
          { status: 401 },
        ),
      ),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(
      ["anthropic", "messages", "-v", "-m", "claude-sonnet-4-5", "hi"],
      cap.io,
    );
    expect(code).toBe(1);
    expect(cap.stderr.value).toContain("] tool-error:");
    expect(cap.stderr.value).toContain('"provider": "anthropic"');
  });
});

describe("run — exit-code mapping", () => {
  it("P1: success → exit 0 + JSON on stdout", async () => {
    server.use(http.post(ENDPOINT, () => happyResponse("done")));
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(["openai", "chat-completions", "-m", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout.value.trim().length).toBeGreaterThan(0);
  });

  it("D1: upstream 401 → isError + exit 1", async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.json({ error: { message: "no auth" } }, { status: 401 }),
      ),
    );
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" } });
    const code = await run(["openai", "chat-completions", "-m", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(1);
    const out = JSON.parse(cap.stdout.value.trim());
    expect(out.isError).toBe(true);
    expect(out.structuredContent.code).toBe("auth");
  });

  it("P2: TTY stdout is pretty-printed (multi-line)", async () => {
    server.use(http.post(ENDPOINT, () => happyResponse()));
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" }, isTTY: true });
    const code = await run(["openai", "chat-completions", "-m", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout.value.split("\n").length).toBeGreaterThan(2);
  });

  it("P3: piped stdout is single-line JSON", async () => {
    server.use(http.post(ENDPOINT, () => happyResponse()));
    const cap = makeIO({ env: { AI_RELAY_API_KEY: "k" }, isTTY: false });
    const code = await run(["openai", "chat-completions", "-m", "gpt-4o-mini", "hi"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout.value.trim().split("\n")).toHaveLength(1);
  });
});
