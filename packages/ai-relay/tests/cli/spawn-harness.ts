import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..", "..");
const BIN_PATH = resolve(SDK_DIR, "dist", "bin", "ai-relay.js");

let buildPromise: Promise<void> | null = null;

export interface SpawnResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface SpawnOpts {
  args: readonly string[];
  env?: Record<string, string | undefined>;
  input?: string;
  inputStream?: (stdin: NodeJS.WritableStream) => Promise<void>;
  killAfterMs?: number;
  killSignal?: NodeJS.Signals;
  timeoutMs?: number;
}

export function getBinPath(): string {
  return BIN_PATH;
}

export async function ensureBuilt(): Promise<void> {
  if (existsSync(BIN_PATH)) return;
  if (!buildPromise) {
    buildPromise = (async () => {
      execFileSync("pnpm", ["--filter", "ai-relay", "build"], {
        cwd: resolve(SDK_DIR, "..", ".."),
        stdio: "pipe",
      });
    })();
  }
  await buildPromise;
}

function sanitizedEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("AI_RELAY_")) continue;
    base[k] = v;
  }
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      base[k] = v;
    }
  }
  return base as NodeJS.ProcessEnv;
}

function writeInput(child: ChildProcessWithoutNullStreams, opts: SpawnOpts): Promise<void> {
  if (opts.input !== undefined) {
    return new Promise<void>((resolveWrite, rejectWrite) => {
      child.stdin.on("error", rejectWrite);
      child.stdin.end(opts.input, () => resolveWrite());
    });
  }
  if (opts.inputStream) {
    return opts.inputStream(child.stdin).then(
      () =>
        new Promise<void>((resolveEnd, rejectEnd) => {
          child.stdin.on("error", rejectEnd);
          child.stdin.end(() => resolveEnd());
        }),
    );
  }
  return new Promise<void>((resolveEnd, rejectEnd) => {
    child.stdin.on("error", rejectEnd);
    child.stdin.end(() => resolveEnd());
  });
}

export async function runCli(opts: SpawnOpts): Promise<SpawnResult> {
  await ensureBuilt();

  const timeoutMs = opts.timeoutMs ?? 10_000;
  const start = performance.now();

  return new Promise<SpawnResult>((resolvePromise, rejectPromise) => {
    const child = spawn("node", [BIN_PATH, ...opts.args], {
      env: sanitizedEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });

    const hardTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    let killTimer: NodeJS.Timeout | undefined;
    if (opts.killAfterMs !== undefined) {
      killTimer = setTimeout(() => {
        child.kill(opts.killSignal ?? "SIGTERM");
      }, opts.killAfterMs);
    }

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (killTimer) clearTimeout(killTimer);
      rejectPromise(err);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (killTimer) clearTimeout(killTimer);
      const durationMs = performance.now() - start;
      resolvePromise({
        status: timedOut ? null : code,
        signal: timedOut ? "SIGKILL" : signal,
        stdout,
        stderr,
        durationMs,
      });
    });

    writeInput(child, opts).catch(() => {
      // EPIPE on closed stdin is expected for negative-path tests.
    });
  });
}
