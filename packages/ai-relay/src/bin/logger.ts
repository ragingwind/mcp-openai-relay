// Verbose stderr logger for the `ai-relay` bin.
//
// Activated by `--verbose` / `-v` on either bin, or by setting the
// `AI_RELAY_VERBOSE` environment variable to a truthy value
// (`1`/`true`/`yes`/`on`, case-insensitive). Flag OR env enables it.
//
// Output rules:
//   - Channel is ALWAYS stderr. stdout carries the JSON-RPC / JSON
//     result and MUST NOT be polluted.
//   - One stage per line: `[ai-relay] <stage>: <data>`.
//     `<data>` may contain embedded newlines (helper inserts a
//     continuation prefix); each event still corresponds to one logical
//     log entry.
//   - Secrets (API keys, bearer tokens, Authorization header values) are
//     redacted to length-only (`***redacted(<n>chars)***`). With those
//     redactions in place, request/response bodies are emitted verbatim
//     so operators can diagnose upstream issues. Treat the stderr stream
//     as sensitive — never persist or share it (see CLAUDE.md §4).

export interface VerboseLogger {
  readonly enabled: boolean;
  log(stage: string, data: unknown): void;
}

export interface VerboseLoggerOptions {
  enabled: boolean;
  stream: { write(chunk: string): void };
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function isVerboseEnv(env: Record<string, string | undefined>): boolean {
  const raw = env.AI_RELAY_VERBOSE;
  if (raw === undefined) return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

export function createVerboseLogger(opts: VerboseLoggerOptions): VerboseLogger {
  if (!opts.enabled) {
    return {
      enabled: false,
      log: () => {
        /* no-op */
      },
    };
  }
  return {
    enabled: true,
    log(stage, data) {
      const rendered = renderData(data);
      const lines = rendered.split("\n");
      const first = lines[0] ?? "";
      let out = `[ai-relay] ${stage}: ${first}\n`;
      for (let i = 1; i < lines.length; i++) {
        out += `[ai-relay]   ${lines[i]}\n`;
      }
      opts.stream.write(out);
    },
  };
}

export function redactSecret(value: string | undefined): string {
  if (value === undefined || value === "") return "(unset)";
  return `***redacted(${value.length}chars)***`;
}

const SECRET_ENV_KEYS = new Set(["AI_RELAY_API_KEY", "AI_RELAY_AUTH_TOKEN"]);

const SECRET_FLAG_NAMES = new Set(["--api-key", "--auth-token"]);

/** Returns a copy of `argv` with the value following `--api-key`
 *  (and other secret flags) replaced by a length-only redaction marker.
 *  Inline `--api-key=value` forms are also redacted. */
export function redactArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    let matchedFlag = false;
    let inlineValue: string | undefined;
    let flagName = tok;
    const eq = tok.indexOf("=");
    if (tok.startsWith("--") && eq !== -1) {
      flagName = tok.slice(0, eq);
      inlineValue = tok.slice(eq + 1);
    }
    if (SECRET_FLAG_NAMES.has(flagName)) {
      matchedFlag = true;
    }
    if (matchedFlag && inlineValue !== undefined) {
      out.push(`${flagName}=${redactSecret(inlineValue)}`);
      continue;
    }
    if (matchedFlag) {
      out.push(tok);
      const next = argv[i + 1];
      if (next !== undefined) {
        out.push(redactSecret(next));
        i += 1;
      }
      continue;
    }
    out.push(tok);
  }
  return out;
}

/** Returns a stable object snapshot of `AI_RELAY_*` env vars with secrets
 *  redacted. Non-AI_RELAY keys are excluded. */
export function snapshotRelayEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  const keys = Object.keys(env)
    .filter((k) => k.startsWith("AI_RELAY_"))
    .sort();
  for (const k of keys) {
    const v = env[k];
    if (v === undefined) continue;
    if (SECRET_ENV_KEYS.has(k)) {
      out[k] = redactSecret(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Emit a chat `messages` array verbatim for verbose output (role + full
 *  content). Returns the array unchanged when it IS an array; otherwise a
 *  shape-matched error object. Use this when the operator opts into
 *  `--verbose` and accepts the body-disclosure trade-off. */
export function dumpMessages(messages: unknown): unknown[] | { error: string } {
  if (!Array.isArray(messages)) {
    return { error: `not-an-array (${typeof messages})` };
  }
  return messages;
}

/** Summarise a chat `messages` array for verbose output without leaking
 *  the full content body. Roles are preserved; content is replaced with
 *  `<chars> chars` + a short prefix. */
export function summariseMessages(
  messages: unknown,
): Array<{ role: unknown; chars: number; preview: string }> | { error: string } {
  if (!Array.isArray(messages)) {
    return { error: `not-an-array (${typeof messages})` };
  }
  return messages.map((m) => {
    const role = (m as { role?: unknown })?.role;
    const content = (m as { content?: unknown })?.content;
    if (typeof content === "string") {
      return {
        role,
        chars: content.length,
        preview: content.length > 60 ? `${content.slice(0, 60)}…` : content,
      };
    }
    return { role, chars: 0, preview: `(non-string content: ${typeof content})` };
  });
}

function renderData(data: unknown): string {
  if (typeof data === "string") return data;
  if (data === undefined) return "(undefined)";
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}
