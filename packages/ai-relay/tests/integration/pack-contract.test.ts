// Publish-contract integration tests for the `ai-relay` tarball.
//
// Runs `pnpm pack` (or `npm pack` — both produce the same tarball layout)
// and asserts:
//   - A1/A5: allowlist of files in the tarball; nothing outside dist/, README,
//     LICENSE, package.json.
//   - A2: each documented subpath imports cleanly from the installed tarball.
//   - A3/A4: types resolve under `moduleResolution: "bundler"` and `"nodenext"`.
//   - A6: LICENSE is present.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..", "..");
const REPO_ROOT = resolve(SDK_DIR, "..", "..");

const ALLOWED_TOP_LEVEL = new Set(["package.json", "README.md", "LICENSE"]);
const FORBIDDEN_PATTERNS = [
  /(^|\/)\.env(\..+)?$/,
  /\.(spec|test)\.[mc]?[jt]sx?$/,
  /\.tsbuildinfo$/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)src(\/|$)/,
];

let tarball: string;
let scratchDir: string;

function listTarballEntries(tarPath: string): string[] {
  const out = execFileSync("tar", ["-tzf", tarPath], { encoding: "utf8" });
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function pack(destDir: string): string {
  // Pack into an isolated dir so this test never races with
  // bin-tarball.test.ts (which packs into SDK_DIR and rms its tarball).
  execFileSync("npm", ["pack", "--pack-destination", destDir], {
    cwd: SDK_DIR,
    stdio: "pipe",
  });
  const tarballs = readdirSync(destDir).filter((f) => f.endsWith(".tgz"));
  if (tarballs.length !== 1 || !tarballs[0]) {
    throw new Error(
      `Expected exactly 1 tarball after npm pack, got ${tarballs.length}: ${tarballs.join(", ")}`,
    );
  }
  return join(destDir, tarballs[0]);
}

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "ai-relay-pack-"));
  tarball = pack(scratchDir);
}, 180_000);

afterAll(() => {
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

describe("pack contract — tarball layout", () => {
  it("A1/A5: tarball only contains dist/**, package.json, README.md, LICENSE", () => {
    const entries = listTarballEntries(tarball);
    expect(entries.length).toBeGreaterThan(0);

    for (const rawEntry of entries) {
      // npm pack prefixes every entry with `package/`. Strip it.
      const entry = rawEntry.replace(/^package\//, "");
      // Skip directory entries (trailing slash).
      if (entry === "" || entry.endsWith("/")) continue;

      const top = entry.split("/")[0];
      const isAllowedTop = top !== undefined && ALLOWED_TOP_LEVEL.has(top);
      const isDist = entry.startsWith("dist/");
      expect(isAllowedTop || isDist, `unexpected file in tarball: ${entry}`).toBe(true);

      for (const pat of FORBIDDEN_PATTERNS) {
        expect(pat.test(entry), `forbidden pattern matched ${entry} (${pat})`).toBe(false);
      }
    }
  });

  it("A6: tarball contains LICENSE", () => {
    const entries = listTarballEntries(tarball);
    const hasLicense = entries.some((e) => e === "package/LICENSE");
    expect(hasLicense).toBe(true);
  });
});

describe("pack contract — installed-tarball imports", () => {
  it("A2: each subpath import resolves and exposes its documented exports", () => {
    const installDir = join(scratchDir, "import-check");
    execFileSync("mkdir", ["-p", installDir]);
    writeFileSync(
      join(installDir, "package.json"),
      JSON.stringify({ name: "pack-import-check", private: true, type: "module" }),
    );
    execFileSync(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        tarball,
        "openai@^6",
        "@anthropic-ai/sdk@^0.96.0",
        "@google/genai@^2.0.0",
      ],
      {
        cwd: installDir,
        stdio: "pipe",
      },
    );

    const script = `
      import * as root from "ai-relay";
      import * as env from "ai-relay/env";
      import * as auth from "ai-relay/auth";
      import * as openai from "ai-relay/openai";
      import * as anthropic from "ai-relay/anthropic";
      import * as google from "ai-relay/google";
      const ok =
        typeof root.verifyBearer === "function" &&
        typeof root.loadConfig === "function" &&
        typeof env.loadConfig === "function" &&
        typeof auth.verifyBearer === "function" &&
        typeof openai.registerOpenAIChat === "function" &&
        typeof openai.makeOpenAIChatHandler === "function" &&
        typeof anthropic.registerAnthropicMessages === "function" &&
        typeof anthropic.makeAnthropicMessagesHandler === "function" &&
        typeof google.registerGoogleGenerateContent === "function" &&
        typeof google.makeGoogleGenerateContentHandler === "function";
      console.log(ok ? "EXPORTS_OK" : "EXPORTS_MISSING");
    `;
    const out = execFileSync("node", ["--input-type=module", "-e", script], {
      cwd: installDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(out.trim()).toBe("EXPORTS_OK");
  }, 120_000);
});

describe("pack contract — typecheck under bundler + nodenext", () => {
  // Each fixture lives under `tests/runtime-fixtures/typecheck-*`. We copy it
  // to a temp dir, install the tarball, install typescript, and run tsc.
  function runTypecheck(fixtureDir: string): void {
    const tmp = join(scratchDir, `tc-${fixtureDir.split("/").pop()}`);
    execFileSync("cp", ["-R", fixtureDir, tmp]);

    // Install ai-relay (from tarball) + typescript in ONE invocation. A
    // second `npm install --no-save <X>` would treat the prior unsaved
    // ai-relay install as extraneous and prune it.
    execFileSync(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--no-save",
        tarball,
        "openai@^6",
        "@anthropic-ai/sdk@^0.96.0",
        "@google/genai@^2.0.0",
        "typescript@^6.0.3",
      ],
      { cwd: tmp, stdio: "pipe" },
    );

    try {
      execFileSync("npx", ["tsc", "--noEmit"], {
        cwd: tmp,
        stdio: "pipe",
      });
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
      const out = (e.stdout ? e.stdout.toString() : "") + (e.stderr ? e.stderr.toString() : "");
      throw new Error(`tsc failed in ${tmp}:\n${out}`);
    }
  }

  it("A3: types resolve under moduleResolution=bundler", () => {
    runTypecheck(join(REPO_ROOT, "tests", "runtime-fixtures", "typecheck-bundler"));
  }, 180_000);

  it("A4: types resolve under moduleResolution=nodenext", () => {
    runTypecheck(join(REPO_ROOT, "tests", "runtime-fixtures", "typecheck-nodenext"));
  }, 180_000);
});

describe("pack contract — README parity", () => {
  // Sanity check that the package's README is included and non-empty.
  it("README is present and references the SDK", () => {
    const tmp = join(scratchDir, "readme-check");
    execFileSync("mkdir", ["-p", tmp]);
    execFileSync("tar", ["-xzf", tarball, "-C", tmp]);
    const readme = readFileSync(join(tmp, "package", "README.md"), "utf8");
    expect(readme.length).toBeGreaterThan(0);
  });
});
