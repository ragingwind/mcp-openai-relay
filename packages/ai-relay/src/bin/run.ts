// CLI orchestrator. Pure with respect to its `io` argument so unit
// tests can drive it without touching real stdio or process.exit.

import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { AnthropicProviderConfig, OpenAIProviderConfig, Provider } from "../config.js";
import { loadConfig } from "../config.js";
import { VERSION } from "../version.js";
import { parseEnvFile } from "./env-file.js";
import {
  createVerboseLogger,
  dumpMessages,
  isVerboseEnv,
  redactArgv,
  redactSecret,
  snapshotRelayEnv,
  type VerboseLogger,
} from "./logger.js";
import { type ParsedInvocation, parseArgv, UsageError } from "./parse.js";
import {
  type AnyProviderConfig,
  type AnyTool,
  providerNames,
  resolveProvider,
  resolveProviderTool,
} from "./registry.js";

export { VERSION };

const USAGE = `Usage: ai-relay <provider> <tool> [flags] [input]

Positionals:
  <provider>              Upstream provider (e.g. openai)
  <tool>                  Tool name within the provider (e.g. chat-completions)

Providers: ${providerNames.join(", ")}

Inputs (exactly one of):
  positional <input>      JSON object {"messages":[...]} or plain text
  stdin (when piped)      JSON object {"messages":[...]} or plain text

The caller-facing tool input schema accepts only {"messages":[...]}; the
upstream model and sampling parameters are configured per server instance
(via flags/env), NOT per call.

Required:
  -m, --model <id>        Upstream model id (or set AI_RELAY_MODEL)

Flags:
      --api-key <key>     Upstream API key (overrides AI_RELAY_API_KEY)
      --base-url <url>    Upstream base URL (overrides AI_RELAY_BASE_URL)
      --max-tokens <n>    Max tokens forwarded upstream (or AI_RELAY_MAX_TOKENS)
      --temperature <f>   Sampling temperature 0..2 (or AI_RELAY_TEMPERATURE)
      --top-p <f>         Nucleus sampling 0..1 (or AI_RELAY_TOP_P)
      --stop <csv>        Stop sequence(s), comma-separated (or AI_RELAY_STOP)
      --timeout <ms>      Request timeout in ms
      --env <path>        Load AI_RELAY_* keys from a dotenv file
  -v, --verbose           Trace stages to stderr (also: AI_RELAY_VERBOSE=1)
  -h, --help              Show this message
  -V, --version           Print SDK version

Examples:
  ai-relay openai chat-completions -m gpt-4o-mini "ping"
  ai-relay openai chat-completions -m gpt-4o-mini --temperature 0.2 "ping"
  AI_RELAY_MODEL=gpt-4o-mini ai-relay openai chat-completions "ping"
  echo '{"messages":[…]}' | ai-relay openai chat-completions -m gpt-4o-mini

Tip: \`ai-relay <provider>\` (without a tool) starts the MCP stdio server.
`;

export interface RunIO {
  stdin: Readable;
  stdinIsTTY: boolean;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  env: Record<string, string | undefined>;
  isTTY: boolean;
}

export async function run(argv: readonly string[], io: RunIO): Promise<number> {
  let parsed: ParsedInvocation;
  try {
    parsed = parseArgv(argv);
  } catch (e) {
    io.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  if (parsed.version) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const verbose = createVerboseLogger({
    enabled: parsed.verbose || isVerboseEnv(io.env),
    stream: io.stderr,
  });
  verbose.log("argv", redactArgv(argv));
  verbose.log("parsed-flags", {
    provider: parsed.provider,
    tool: parsed.tool,
    positional: parsed.positional === undefined ? "(none)" : `(${parsed.positional.length} chars)`,
    flags: redactParsedFlags(parsed.flags),
    verbose: parsed.verbose,
  });
  verbose.log("env-snapshot", snapshotRelayEnv(io.env));

  const providerEntry = await resolveProvider(parsed.provider);
  if (!providerEntry) {
    io.stderr.write(
      `unknown provider: ${parsed.provider}\nknown providers: ${providerNames.join(", ")}\n`,
    );
    return 2;
  }
  const tool = await resolveProviderTool(parsed.provider, parsed.tool);
  if (!tool) {
    io.stderr.write(
      `unknown tool for provider ${parsed.provider}: ${parsed.tool}\nknown tools: ${Object.keys(providerEntry.tools).join(", ")}\n`,
    );
    return 2;
  }

  const stdinResult = await readStdinIfPiped(io.stdin, io.stdinIsTTY);
  if (parsed.positional !== undefined && stdinResult.kind === "text") {
    io.stderr.write("received both stdin and positional input; pass exactly one\n");
    return 2;
  }
  let rawInput: string | undefined;
  if (parsed.positional !== undefined) {
    rawInput = parsed.positional;
  } else if (stdinResult.kind === "text") {
    rawInput = stdinResult.value;
  } else if (stdinResult.kind === "empty-pipe") {
    io.stderr.write("received empty stdin; pipe a JSON object or plain text\n");
    return 2;
  }
  if (rawInput === undefined) {
    io.stderr.write(`${parsed.tool} requires input (positional or stdin)\n`);
    return 2;
  }

  verbose.log("cli-input-raw", {
    source: parsed.positional !== undefined ? "positional" : "stdin",
    chars: rawInput.length,
    kind: isJsonInput(rawInput) ? "json" : "plain-text",
  });

  let inputObj: Record<string, unknown>;
  try {
    inputObj = coerceInput(rawInput, tool);
  } catch (e) {
    io.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }

  verbose.log("cli-input-parsed", {
    keys: Object.keys(inputObj),
    messages: dumpMessages(inputObj.messages),
  });

  let envFileMap: Record<string, string> = {};
  if (parsed.flags.env !== undefined) {
    let body: string;
    try {
      body = await readFile(parsed.flags.env, "utf8");
    } catch (e) {
      const cause = e instanceof Error ? e.message : "unknown error";
      io.stderr.write(`cannot read --env file ${parsed.flags.env}: ${cause}\n`);
      return 2;
    }
    try {
      envFileMap = parseEnvFile(body);
    } catch (e) {
      io.stderr.write(`${(e as Error).message}\n`);
      return 2;
    }
  }

  const effectiveEnv = { ...io.env, ...envFileMap };

  const args: Record<string, unknown> = { provider: parsed.provider as Provider };
  if (parsed.flags["api-key"] !== undefined) args.apiKey = parsed.flags["api-key"];
  if (parsed.flags["base-url"] !== undefined) args.baseURL = parsed.flags["base-url"];
  if (parsed.flags.model !== undefined) args.model = parsed.flags.model;
  if (parsed.flags.temperature !== undefined) args.temperature = parsed.flags.temperature;
  if (parsed.flags["max-tokens"] !== undefined) args.max_tokens = parsed.flags["max-tokens"];
  if (parsed.flags["top-p"] !== undefined) args.top_p = parsed.flags["top-p"];
  if (parsed.flags.stop !== undefined) args.stop = parsed.flags.stop;
  if (parsed.flags.timeout !== undefined) args.requestTimeoutMs = parsed.flags.timeout;

  let providerConfig: OpenAIProviderConfig | AnthropicProviderConfig;
  try {
    const cfg = loadConfig({ env: effectiveEnv, args });
    const first = cfg.providers[0];
    if (!first) throw new Error("loadConfig returned no providers");
    providerConfig = first;
  } catch (e) {
    io.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }

  verbose.log("loaded-config", {
    apiKey: redactSecret(providerConfig.apiKey),
    baseURL: providerConfig.baseURL ?? "(default)",
    model: providerConfig.model,
    temperature: providerConfig.temperature ?? "(unset)",
    max_tokens: providerConfig.max_tokens ?? "(unset)",
    top_p: providerConfig.top_p ?? "(unset)",
    stop: providerConfig.stop ?? "(unset)",
    requestTimeoutMs: providerConfig.requestTimeoutMs ?? "(default)",
  });

  const toolConfig = buildToolConfig(parsed.provider as Provider, providerConfig, verbose);

  const bundle = tool.makeHandler(toolConfig) as {
    handler: (
      rawInput: unknown,
      extra?: { signal?: AbortSignal },
    ) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      structuredContent: { code?: string; retryAfter?: number };
      isError: boolean;
    }>;
  };

  const result = await bundle.handler(inputObj);

  if (result.isError) {
    verbose.log("tool-error", {
      provider: parsed.provider,
      code: result.structuredContent.code,
      retryAfter: result.structuredContent.retryAfter,
    });
  }

  verbose.log("result", {
    isError: result.isError,
    content: result.content,
    structuredContent: result.structuredContent,
  });

  const output = io.isTTY ? JSON.stringify(result, null, 2) : JSON.stringify(result);
  io.stdout.write(`${output}\n`);
  return result.isError ? 1 : 0;
}

function redactParsedFlags(flags: ParsedInvocation["flags"]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...flags };
  if (out["api-key"] !== undefined) {
    out["api-key"] = redactSecret(out["api-key"] as string);
  }
  return out;
}

function isJsonInput(raw: string): boolean {
  const trimmed = raw.trimStart();
  const first = trimmed[0];
  return first === "{" || first === "[";
}

function coerceInput(raw: string, tool: AnyTool): Record<string, unknown> {
  const trimmed = raw.trimStart();
  const first = trimmed[0];
  if (first === "{" || first === "[") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new UsageError("input is not valid JSON");
    }
    if (Array.isArray(parsed)) {
      throw new UsageError(`input JSON for ${tool.name} must be an object, not an array`);
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new UsageError("input JSON must be an object");
    }
    return parsed as Record<string, unknown>;
  }
  if (!tool.desugar) {
    throw new UsageError(`tool ${tool.name} does not accept plain text input; pass JSON`);
  }
  return tool.desugar(raw);
}

function buildToolConfig(
  _provider: Provider,
  cfg: OpenAIProviderConfig | AnthropicProviderConfig,
  verbose: VerboseLogger,
): AnyProviderConfig {
  const common = {
    apiKey: cfg.apiKey,
    ...(cfg.baseURL !== undefined ? { baseURL: cfg.baseURL } : {}),
    model: cfg.model,
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
    ...(cfg.max_tokens !== undefined ? { max_tokens: cfg.max_tokens } : {}),
    ...(cfg.top_p !== undefined ? { top_p: cfg.top_p } : {}),
    ...(cfg.stop !== undefined ? { stop: cfg.stop } : {}),
    ...(cfg.requestTimeoutMs !== undefined ? { requestTimeoutMs: cfg.requestTimeoutMs } : {}),
    ...(verbose.enabled ? { logger: verbose } : {}),
  };
  return common as AnyProviderConfig;
}

type StdinResult = { kind: "tty" } | { kind: "text"; value: string } | { kind: "empty-pipe" };

async function readStdinIfPiped(stdin: Readable, stdinIsTTY: boolean): Promise<StdinResult> {
  if (stdinIsTTY) return { kind: "tty" };
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  const text = chunks.length === 0 ? "" : Buffer.concat(chunks).toString("utf8");
  return text.length === 0 ? { kind: "empty-pipe" } : { kind: "text", value: text };
}
