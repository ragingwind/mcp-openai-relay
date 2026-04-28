#!/usr/bin/env node
// Pre-flight for `pnpm dev`. lib/env.ts re-validates at module load, but that
// only fires on the first request — by then `next dev` has already booted and
// the failure surfaces as a buried request-stack trace. Catching it here keeps
// the failure mode visible before the server starts.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENV_PATH = resolve(process.cwd(), ".env.local");
const REQUIRED = ["RELAY_AUTH_TOKEN"];

function fail(lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

if (!existsSync(ENV_PATH)) {
  fail([
    "",
    "[mcp-openai-relay] .env.local is missing.",
    "",
    "  cp .env.example .env.local",
    "  # then set RELAY_AUTH_TOKEN (required) and OPENAI_API_KEY (optional)",
    "  # token: openssl rand -hex 32",
    "",
  ]);
}

const raw = readFileSync(ENV_PATH, "utf8");
const dotenv = Object.fromEntries(
  raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const idx = line.indexOf("=");
      const k = line.slice(0, idx).trim();
      let v = line.slice(idx + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      return [k, v];
    }),
);

const missing = REQUIRED.filter((key) => !dotenv[key]);
if (missing.length > 0) {
  fail([
    "",
    `[mcp-openai-relay] .env.local missing required values: ${missing.join(", ")}`,
    "",
    "  Edit .env.local and set:",
    ...missing.map((k) => `    ${k}=...`),
    "",
    "  Generate RELAY_AUTH_TOKEN if needed:  openssl rand -hex 32",
    "",
  ]);
}

if (Buffer.byteLength(dotenv.RELAY_AUTH_TOKEN, "utf8") < 32) {
  fail([
    "",
    "[mcp-openai-relay] RELAY_AUTH_TOKEN must be at least 32 bytes.",
    "  Regenerate:  openssl rand -hex 32",
    "",
  ]);
}
