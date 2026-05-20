// argv → ParsedInvocation. Pure module with no I/O.
//
// Surface: `ai-relay <provider> <tool> [flags] [input]`
//
// Long flags: --system -s, --model -m, --api-key, --base-url,
//             --max-tokens, --temperature, --top-p, --stop,
//             --timeout, --env, --verbose -v,
//             --help -h, --version -V.
//
// Short forms: only the ones listed above are accepted.

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface ParsedFlags {
  system?: string;
  model?: string;
  "api-key"?: string;
  "base-url"?: string;
  "max-tokens"?: number;
  temperature?: number;
  "top-p"?: number;
  stop?: string | string[];
  timeout?: number;
  env?: string;
}

export interface ParsedInvocation {
  help: boolean;
  version: boolean;
  verbose: boolean;
  provider: string;
  tool: string;
  flags: ParsedFlags;
  positional?: string;
}

const VALUE_FLAGS = new Set([
  "system",
  "model",
  "api-key",
  "base-url",
  "max-tokens",
  "temperature",
  "top-p",
  "stop",
  "timeout",
  "env",
]);
const INTEGER_FLAGS = new Set(["max-tokens", "timeout"]);
const FLOAT_FLAGS = new Set(["temperature", "top-p"]);
const STRING_ARRAY_FLAGS = new Set(["stop"]);
const SHORT_TO_LONG: Record<string, string> = {
  s: "system",
  m: "model",
  h: "help",
  V: "version",
  v: "verbose",
};

function parsePositiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new UsageError(`--${name} must be a positive integer`);
  }
  return n;
}

function parseNonNegativeFloat(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new UsageError(`--${name} must be a non-negative number`);
  }
  return n;
}

function parseStringList(raw: string): string | string[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return raw;
  if (parts.length === 1) {
    const first = parts[0];
    if (first === undefined) return raw;
    return first;
  }
  return parts;
}

function assignFlag(out: Record<string, unknown>, key: string, raw: string): void {
  if (INTEGER_FLAGS.has(key)) {
    out[key] = parsePositiveInt(key, raw);
    return;
  }
  if (FLOAT_FLAGS.has(key)) {
    out[key] = parseNonNegativeFloat(key, raw);
    return;
  }
  if (STRING_ARRAY_FLAGS.has(key)) {
    out[key] = parseStringList(raw);
    return;
  }
  out[key] = raw;
}

export function parseArgv(argv: readonly string[]): ParsedInvocation {
  const out: ParsedInvocation = {
    help: false,
    version: false,
    verbose: false,
    provider: "",
    tool: "",
    flags: {},
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;

    if (tok === "--") {
      for (let j = i + 1; j < argv.length; j++) {
        const v = argv[j];
        if (v !== undefined) positionals.push(v);
      }
      break;
    }

    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      const key = eq === -1 ? body : body.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);

      if (key === "help") {
        out.help = true;
        continue;
      }
      if (key === "version") {
        out.version = true;
        continue;
      }
      if (key === "verbose") {
        out.verbose = true;
        continue;
      }
      if (!VALUE_FLAGS.has(key)) {
        throw new UsageError(`unknown flag: --${key}`);
      }
      let value: string;
      if (inlineValue !== undefined) {
        value = inlineValue;
      } else {
        const next = argv[i + 1];
        if (next === undefined) {
          throw new UsageError(`--${key} requires a value`);
        }
        value = next;
        i += 1;
      }
      assignFlag(out.flags as Record<string, unknown>, key, value);
      continue;
    }

    if (tok.startsWith("-") && tok !== "-") {
      const body = tok.slice(1);
      const eq = body.indexOf("=");
      const short = eq === -1 ? body : body.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);
      const long = SHORT_TO_LONG[short];
      if (!long) {
        throw new UsageError(`unknown flag: -${short}`);
      }
      if (long === "help") {
        out.help = true;
        continue;
      }
      if (long === "version") {
        out.version = true;
        continue;
      }
      if (long === "verbose") {
        out.verbose = true;
        continue;
      }
      let value: string;
      if (inlineValue !== undefined) {
        value = inlineValue;
      } else {
        const next = argv[i + 1];
        if (next === undefined) {
          throw new UsageError(`-${short} requires a value`);
        }
        value = next;
        i += 1;
      }
      assignFlag(out.flags as Record<string, unknown>, long, value);
      continue;
    }

    positionals.push(tok);
  }

  if (out.help || out.version) {
    return out;
  }

  if (positionals.length < 2) {
    throw new UsageError("usage: ai-relay <provider> <tool> [flags] [input]");
  }

  const provider = positionals[0];
  const tool = positionals[1];
  if (provider === undefined || tool === undefined) {
    throw new UsageError("usage: ai-relay <provider> <tool> [flags] [input]");
  }
  out.provider = provider;
  out.tool = tool;

  if (positionals.length > 3) {
    throw new UsageError("at most one positional input is accepted after <tool>");
  }
  if (positionals.length === 3) {
    const pos = positionals[2];
    if (pos !== undefined) out.positional = pos;
  }

  return out;
}

// argv → ParsedMcpInvocation. Pure module with no I/O.
//
// Surface: `ai-relay <provider> [flags]`
// Flags: --model -m, --api-key, --base-url, --max-tokens, --temperature,
//        --top-p, --stop, --timeout, --env, --verbose -v,
//        --help -h, --version -V.

export interface ParsedMcpFlags {
  model?: string;
  "api-key"?: string;
  "base-url"?: string;
  "max-tokens"?: number;
  temperature?: number;
  "top-p"?: number;
  stop?: string | string[];
  timeout?: number;
  env?: string;
}

export interface ParsedMcpInvocation {
  help: boolean;
  version: boolean;
  verbose: boolean;
  provider?: string;
  flags: ParsedMcpFlags;
}

const MCP_VALUE_FLAGS = new Set([
  "model",
  "api-key",
  "base-url",
  "max-tokens",
  "temperature",
  "top-p",
  "stop",
  "timeout",
  "env",
]);
const MCP_SHORT_TO_LONG: Record<string, string> = {
  m: "model",
};

export function parseMcpArgv(argv: readonly string[]): ParsedMcpInvocation {
  const out: ParsedMcpInvocation = {
    help: false,
    version: false,
    verbose: false,
    flags: {},
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;

    if (tok === "--") {
      for (let j = i + 1; j < argv.length; j++) {
        const v = argv[j];
        if (v !== undefined) positionals.push(v);
      }
      break;
    }

    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      const key = eq === -1 ? body : body.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);

      if (key === "help") {
        out.help = true;
        continue;
      }
      if (key === "version") {
        out.version = true;
        continue;
      }
      if (key === "verbose") {
        out.verbose = true;
        continue;
      }
      if (!MCP_VALUE_FLAGS.has(key)) {
        throw new UsageError(`unknown flag: --${key}`);
      }
      let value: string;
      if (inlineValue !== undefined) {
        value = inlineValue;
      } else {
        const next = argv[i + 1];
        if (next === undefined) {
          throw new UsageError(`--${key} requires a value`);
        }
        value = next;
        i += 1;
      }
      assignFlag(out.flags as Record<string, unknown>, key, value);
      continue;
    }

    if (tok.startsWith("-") && tok !== "-") {
      const body = tok.slice(1);
      const eq = body.indexOf("=");
      const short = eq === -1 ? body : body.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);
      if (short === "h") {
        out.help = true;
        continue;
      }
      if (short === "V") {
        out.version = true;
        continue;
      }
      if (short === "v") {
        out.verbose = true;
        continue;
      }
      const long = MCP_SHORT_TO_LONG[short];
      if (!long) {
        throw new UsageError(`unknown flag: -${short}`);
      }
      let value: string;
      if (inlineValue !== undefined) {
        value = inlineValue;
      } else {
        const next = argv[i + 1];
        if (next === undefined) {
          throw new UsageError(`-${short} requires a value`);
        }
        value = next;
        i += 1;
      }
      assignFlag(out.flags as Record<string, unknown>, long, value);
      continue;
    }

    positionals.push(tok);
  }

  if (out.help || out.version) {
    return out;
  }

  if (positionals.length === 0) {
    return out;
  }
  if (positionals.length > 1) {
    throw new UsageError("usage: ai-relay <provider> [flags]");
  }
  const first = positionals[0];
  if (first !== undefined) out.provider = first;
  return out;
}

export function countPositionals(argv: readonly string[]): number {
  const ALL_VALUE_FLAGS = new Set([
    "system",
    "model",
    "api-key",
    "base-url",
    "max-tokens",
    "temperature",
    "top-p",
    "stop",
    "timeout",
    "env",
  ]);
  const VALUE_SHORTS = new Set(["s", "m"]);
  let count = 0;
  let pastDash = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (pastDash) {
      count++;
      continue;
    }
    if (tok === "--") {
      pastDash = true;
      continue;
    }
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq === -1 && ALL_VALUE_FLAGS.has(body)) i++;
      continue;
    }
    if (tok.startsWith("-") && tok !== "-") {
      const body = tok.slice(1);
      const eq = body.indexOf("=");
      const short = eq === -1 ? body : body.slice(0, eq);
      if (eq === -1 && VALUE_SHORTS.has(short)) i++;
      continue;
    }
    count++;
  }
  return count;
}
