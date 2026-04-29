#!/usr/bin/env node
// Real-server smoke test. Run `pnpm dev` in another terminal first, then
// `pnpm verify` here.
//
// Sends JSON-RPC directly to /api/mcp, covering C1, C2, C5 from
// doc/QA-MCP-INSPECTOR.md. The MCP Inspector UI is bypassed — its only role in
// the manual procedure is to construct these same requests for a human.
//
// Skipped:
//   C4 (max_tokens clamp) — server-side, invisible to client; covered by
//      tests/unit/completion-chat.test.ts.
//   C6 (cancellation)     — relies on visual inspection of the OpenAI usage
//      page; stays manual per QA-MCP-INSPECTOR.md.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENV_PATH = resolve(process.cwd(), ".env.local");

if (!existsSync(ENV_PATH)) {
  console.error("[verify] .env.local missing — run `pnpm dev` once to surface setup steps.");
  process.exit(1);
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

const TOKEN = dotenv.RELAY_AUTH_TOKEN;
if (!TOKEN) {
  console.error("[verify] RELAY_AUTH_TOKEN missing in .env.local");
  process.exit(1);
}

const argUrl = process.argv.slice(2).find((a) => a.startsWith("--url="));
const URL_BASE =
  (argUrl && argUrl.slice("--url=".length)) ||
  process.env.MCP_URL ||
  "http://localhost:3000/api/mcp";

const MODEL = process.env.VERIFY_MODEL || "gpt-4o-mini";
const ACCEPT_BOTH = "application/json, text/event-stream";

async function readJsonRpc(res) {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  const text = await res.text();
  const lines = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((s) => s && s !== "[DONE]");
  if (!lines.length) throw new Error("No SSE data lines in response");
  return JSON.parse(lines.at(-1));
}

async function rpc(body, opts = {}) {
  return fetch(URL_BASE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: ACCEPT_BOTH,
      authorization: `Bearer ${opts.token ?? TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

const results = [];
function record(id, label, pass, note) {
  results.push({ id, label, pass, note });
  const stamp = pass ? "PASS" : "FAIL";
  console.log(`[${stamp}] ${id}  ${label}${note ? "  — " + note : ""}`);
}

try {
  await fetch(URL_BASE, { method: "GET" });
} catch {
  console.error("");
  console.error(`[verify] cannot reach ${URL_BASE}`);
  console.error("         run `pnpm dev` in another terminal first.");
  console.error("         override URL: pnpm verify --url=http://localhost:3001/api/mcp");
  console.error("");
  process.exit(1);
}

console.log(`endpoint:  ${URL_BASE}`);
console.log(`model:     ${MODEL}`);
console.log("");

// ---- C1: tools/list ----------------------------------------------------

try {
  const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const env = await readJsonRpc(res);
  const tools = env.result?.tools ?? [];
  const ok = tools.length === 1 && tools[0]?.name === "completion_chat";
  record(
    "C1",
    "tools/list — single completion_chat",
    ok,
    ok ? "1 tool" : `got ${JSON.stringify(tools.map((t) => t.name))}`,
  );
} catch (err) {
  record("C1", "tools/list — single completion_chat", false, err.message);
}

// ---- C2: completion_chat happy path ---------------------------------------

try {
  const res = await rpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "completion_chat",
      arguments: {
        model: MODEL,
        messages: [{ role: "user", content: "ping" }],
      },
    },
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const env = await readJsonRpc(res);
  const result = env.result;
  const text = result?.content?.[0]?.text ?? "";
  const usage = result?.structuredContent?.usage;
  const ok =
    result?.isError === false &&
    typeof text === "string" &&
    text.length > 0 &&
    typeof usage?.total_tokens === "number" &&
    usage.total_tokens > 0;
  const note = usage
    ? `prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`
    : "no usage";
  record("C2", "completion_chat happy path", ok, note);
} catch (err) {
  record("C2", "completion_chat happy path", false, err.message);
}

// ---- C5: wrong bearer 401 ---------------------------------------------

try {
  const res = await rpc(
    { jsonrpc: "2.0", id: 5, method: "tools/list" },
    { token: "wrong-token-1234567890123456789012" },
  );
  const wwwAuth = res.headers.get("www-authenticate") || "";
  const ok = res.status === 401 && /Bearer/i.test(wwwAuth);
  record("C5", "wrong bearer 401 + WWW-Authenticate", ok, `HTTP ${res.status}`);
} catch (err) {
  record("C5", "wrong bearer 401 + WWW-Authenticate", false, err.message);
}

// ---- Summary + evidence record ---------------------------------------

console.log("");
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} scenarios passed`);
console.log("");
console.log("--- evidence record (paste into PR) ---");
console.log(`MCP smoke verification — ${new Date().toISOString()}`);
console.log(`Endpoint:  ${URL_BASE}`);
console.log(`Model:     ${MODEL}`);
console.log("");
for (const r of results) {
  console.log(`${r.id}  ${r.pass ? "PASS" : "FAIL"}  ${r.label}${r.note ? " — " + r.note : ""}`);
}
console.log("C4  N/A   server-side clamp; covered by unit tests");
console.log("C6  N/A   cancellation; manual only");
console.log("--- end ---");

process.exit(passed === results.length ? 0 : 1);
