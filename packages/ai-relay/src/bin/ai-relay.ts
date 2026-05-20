#!/usr/bin/env node
// `ai-relay <provider>` — start an MCP stdio server that relays calls
// to the upstream provider's tools (today: openai → chat-completions).

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import type { AnthropicProviderConfig, OpenAIProviderConfig, Provider } from "../config.js";
import { loadConfig } from "../config.js";
import { VERSION } from "../version.js";
import { parseEnvFile } from "./env-file.js";
import {
  createVerboseLogger,
  isVerboseEnv,
  redactArgv,
  redactSecret,
  snapshotRelayEnv,
} from "./logger.js";
import { startMcpServer } from "./mcp-server.js";
import { countPositionals, type ParsedMcpInvocation, parseMcpArgv, UsageError } from "./parse.js";
import { providerNames, resolveProvider } from "./registry.js";
import { run } from "./run.js";

export { VERSION };

const USAGE = `Usage: ai-relay <provider> [flags]

Start an MCP stdio server that relays calls to the given provider's tools.
Intended to be spawned by an MCP host (Claude Desktop, Claude Code, Cursor, …)
— do not run interactively.

Providers:
  ${providerNames.join(", ")}

Required:
  -m, --model <id>        Upstream model id (or set AI_RELAY_MODEL)

Flags:
      --api-key <key>     Upstream API key (overrides AI_RELAY_API_KEY)
      --base-url <url>    Upstream base URL (overrides AI_RELAY_BASE_URL)
      --max-tokens <n>    Max tokens forwarded upstream (or AI_RELAY_MAX_TOKENS)
      --temperature <f>   Sampling temperature 0..2 (or AI_RELAY_TEMPERATURE)
      --top-p <f>         Nucleus sampling 0..1 (or AI_RELAY_TOP_P)
      --stop <csv>        Stop sequence(s), comma-separated (or AI_RELAY_STOP)
      --timeout <ms>      Upstream request timeout in ms
      --env <path>        Load AI_RELAY_* keys from a dotenv file
  -v, --verbose           Trace stages to stderr (also: AI_RELAY_VERBOSE=1)
  -h, --help              Show this message
  -V, --version           Print SDK version

Example claude_desktop_config.json:
  {
    "mcpServers": {
      "ai-relay": {
        "command": "npx",
        "args": ["-y", "ai-relay", "openai", "-m", "gpt-4o-mini"],
        "env": { "AI_RELAY_API_KEY": "sk-..." }
      }
    }
  }

For one-shot CLI invocation, pass a tool name as the second positional:
  ai-relay openai chat-completions -m gpt-4o-mini "ping"
  echo '{"messages":[...]}' | ai-relay openai chat-completions -m gpt-4o-mini
`;

const USAGE_NO_PROVIDER = `error: <provider> positional is required

usage: ai-relay <provider> [flags]
providers: ${providerNames.join(", ")}

For one-shot CLI invocation: ai-relay <provider> <tool> [flags] [input]
`;

export interface AiRelayIO {
  stdin: Readable;
  stdinIsTTY: boolean;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  env: Record<string, string | undefined>;
  isTTY: boolean;
}

export async function main(argv: readonly string[], io: AiRelayIO): Promise<number> {
  if (countPositionals(argv) >= 2) {
    return run(argv, io);
  }
  let parsed: ParsedMcpInvocation;
  try {
    parsed = parseMcpArgv(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr.write(`${e.message}\n`);
      return 2;
    }
    throw e;
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
    flags: redactMcpFlags(parsed.flags),
    verbose: parsed.verbose,
  });
  verbose.log("env-snapshot", snapshotRelayEnv(io.env));

  if (parsed.provider === undefined) {
    io.stderr.write(USAGE_NO_PROVIDER);
    return 2;
  }

  const providerEntry = await resolveProvider(parsed.provider);
  if (providerEntry === undefined) {
    io.stderr.write(
      `unknown provider: ${parsed.provider}\nknown providers: ${providerNames.join(", ")}\n`,
    );
    return 2;
  }

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

  await startMcpServer({
    provider: parsed.provider,
    providerEntry,
    version: VERSION,
    logger: verbose,
    config: {
      apiKey: providerConfig.apiKey,
      ...(providerConfig.baseURL !== undefined ? { baseURL: providerConfig.baseURL } : {}),
      model: providerConfig.model,
      ...(providerConfig.temperature !== undefined
        ? { temperature: providerConfig.temperature }
        : {}),
      ...(providerConfig.max_tokens !== undefined ? { max_tokens: providerConfig.max_tokens } : {}),
      ...(providerConfig.top_p !== undefined ? { top_p: providerConfig.top_p } : {}),
      ...(providerConfig.stop !== undefined ? { stop: providerConfig.stop } : {}),
      ...(providerConfig.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: providerConfig.requestTimeoutMs }
        : {}),
    },
  });
  return 0;
}

function redactMcpFlags(flags: ParsedMcpInvocation["flags"]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...flags };
  if (out["api-key"] !== undefined) {
    out["api-key"] = redactSecret(out["api-key"] as string);
  }
  return out;
}

// Entry shim — invoked when this file is executed directly as the bin.
// Vitest imports the module without triggering this branch. argv[1] may be
// a symlink (npm installs the bin under node_modules/.bin via symlink), so
// resolve it through realpath before comparing to import.meta.url.
function isDirectInvocationCheck(): boolean {
  if (typeof process === "undefined") return false;
  if (!Array.isArray(process.argv)) return false;
  const arg1 = process.argv[1];
  if (arg1 === undefined) return false;
  let realArg1: string;
  try {
    realArg1 = realpathSync(arg1);
  } catch {
    realArg1 = arg1;
  }
  return import.meta.url === pathToFileURL(realArg1).href;
}
const isDirectInvocation = isDirectInvocationCheck();

if (isDirectInvocation) {
  main(process.argv.slice(2), {
    stdin: process.stdin,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    isTTY: Boolean(process.stdout.isTTY),
  }).then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (err: unknown) => {
      process.stderr.write(`${(err as Error).stack ?? (err as Error).message}\n`);
      process.exit(1);
    },
  );
}
