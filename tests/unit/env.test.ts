import { describe, expect, it } from "vitest";
import { type EnvSource, parseEnv } from "../../lib/env.js";

// A minimal-valid input — every behavior test starts from this and overrides
// the one or two keys it cares about. Avoids re-declaring boilerplate per case.
const minimalValid = {
  OPENAI_API_KEY: "test-openai-api-key",
  RELAY_AUTH_TOKEN: "x".repeat(32),
} satisfies EnvSource;

const expectThrow = (input: EnvSource): Error => {
  let thrown: unknown;
  try {
    parseEnv(input);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(Error);
  return thrown as Error;
};

describe("parseEnv — required keys", () => {
  // B1: OPENAI_API_KEY missing → defaults to empty string
  it("defaults OPENAI_API_KEY to empty string when missing", () => {
    const env = parseEnv({ RELAY_AUTH_TOKEN: "x".repeat(32) });
    expect(env.OPENAI_API_KEY).toBe("");
  });

  // B2: RELAY_AUTH_TOKEN missing
  it("throws when RELAY_AUTH_TOKEN is missing", () => {
    const err = expectThrow({ OPENAI_API_KEY: "k" });
    expect(err.message).toContain("RELAY_AUTH_TOKEN");
  });

  // B3: empty OPENAI_API_KEY is accepted
  it("accepts empty OPENAI_API_KEY", () => {
    const env = parseEnv({ OPENAI_API_KEY: "", RELAY_AUTH_TOKEN: "x".repeat(32) });
    expect(env.OPENAI_API_KEY).toBe("");
  });

  // B4: RELAY_AUTH_TOKEN under 32 bytes
  it("throws when RELAY_AUTH_TOKEN is 31 bytes (one byte under the floor)", () => {
    const err = expectThrow({ OPENAI_API_KEY: "k", RELAY_AUTH_TOKEN: "x".repeat(31) });
    expect(err.message).toContain("RELAY_AUTH_TOKEN");
    expect(err.message).toContain("at least 32 bytes");
  });

  // B5: RELAY_AUTH_TOKEN exactly 32 bytes
  it("accepts RELAY_AUTH_TOKEN at exactly 32 bytes", () => {
    const env = parseEnv({ OPENAI_API_KEY: "k", RELAY_AUTH_TOKEN: "x".repeat(32) });
    expect(env.RELAY_AUTH_TOKEN).toBe("x".repeat(32));
  });

  // B6: RELAY_AUTH_TOKEN multibyte — 8 chars × 4 bytes/char = 32 UTF-8 bytes
  it("measures RELAY_AUTH_TOKEN length in bytes, not characters", () => {
    const multibyte = "🦊".repeat(8); // 8 chars, 32 UTF-8 bytes
    expect(multibyte.length).toBe(16); // JS char-length is surrogate-pair-counted (16)
    expect(Buffer.byteLength(multibyte, "utf8")).toBe(32);
    const env = parseEnv({ OPENAI_API_KEY: "k", RELAY_AUTH_TOKEN: multibyte });
    expect(env.RELAY_AUTH_TOKEN).toBe(multibyte);
  });
});

describe("parseEnv — defaults", () => {
  // B7: MODEL_ALLOWLIST default
  it("applies the default 4-model allowlist when MODEL_ALLOWLIST is undefined", () => {
    const env = parseEnv(minimalValid);
    expect(env.MODEL_ALLOWLIST).toEqual(["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"]);
  });

  // B10: MAX_OUTPUT_TOKENS_CEILING default
  it("defaults MAX_OUTPUT_TOKENS_CEILING to 4096 when undefined", () => {
    const env = parseEnv(minimalValid);
    expect(env.MAX_OUTPUT_TOKENS_CEILING).toBe(4096);
  });

  // B16: REQUEST_TIMEOUT_MS default
  it("defaults REQUEST_TIMEOUT_MS to 60000 when undefined", () => {
    const env = parseEnv(minimalValid);
    expect(env.REQUEST_TIMEOUT_MS).toBe(60_000);
  });
});

describe("parseEnv — MODEL_ALLOWLIST CSV", () => {
  // B8: trim whitespace around entries
  it("trims whitespace around each CSV entry", () => {
    const env = parseEnv({ ...minimalValid, MODEL_ALLOWLIST: "a , b , c" });
    expect(env.MODEL_ALLOWLIST).toEqual(["a", "b", "c"]);
  });

  // B9: filter empty entries (consecutive commas, trailing comma)
  it("filters empty entries in the CSV (consecutive and trailing commas)", () => {
    const env = parseEnv({ ...minimalValid, MODEL_ALLOWLIST: "a,,c," });
    expect(env.MODEL_ALLOWLIST).toEqual(["a", "c"]);
  });

  // OQ-2: explicit empty string → zero-length list → throws
  it("refuses an explicit empty MODEL_ALLOWLIST (OQ-2: zero-length list)", () => {
    const err = expectThrow({ ...minimalValid, MODEL_ALLOWLIST: "" });
    expect(err.message).toContain("MODEL_ALLOWLIST");
    expect(err.message).toContain("at least one entry");
  });

  // OQ-2 cont.: only commas/whitespace → also zero-length → throws
  it("refuses MODEL_ALLOWLIST that contains only commas and whitespace", () => {
    const err = expectThrow({ ...minimalValid, MODEL_ALLOWLIST: " , , " });
    expect(err.message).toContain("MODEL_ALLOWLIST");
    expect(err.message).toContain("at least one entry");
  });
});

describe("parseEnv — numeric coercion", () => {
  // B11: numeric string coerced to number
  it("coerces a numeric string MAX_OUTPUT_TOKENS_CEILING to a number", () => {
    const env = parseEnv({ ...minimalValid, MAX_OUTPUT_TOKENS_CEILING: "8192" });
    expect(env.MAX_OUTPUT_TOKENS_CEILING).toBe(8192);
    expect(typeof env.MAX_OUTPUT_TOKENS_CEILING).toBe("number");
  });

  // B12: zero rejected (positive int requirement)
  it("rejects MAX_OUTPUT_TOKENS_CEILING = 0", () => {
    const err = expectThrow({ ...minimalValid, MAX_OUTPUT_TOKENS_CEILING: "0" });
    expect(err.message).toContain("MAX_OUTPUT_TOKENS_CEILING");
  });

  // B13: negative rejected
  it("rejects negative MAX_OUTPUT_TOKENS_CEILING", () => {
    const err = expectThrow({ ...minimalValid, MAX_OUTPUT_TOKENS_CEILING: "-1" });
    expect(err.message).toContain("MAX_OUTPUT_TOKENS_CEILING");
  });

  // B14: non-integer rejected (.int() refinement)
  it("rejects non-integer MAX_OUTPUT_TOKENS_CEILING", () => {
    const err = expectThrow({ ...minimalValid, MAX_OUTPUT_TOKENS_CEILING: "1.5" });
    expect(err.message).toContain("MAX_OUTPUT_TOKENS_CEILING");
  });

  // B15: non-numeric rejected (z.coerce.number returns NaN, then .int() fails)
  it("rejects non-numeric MAX_OUTPUT_TOKENS_CEILING", () => {
    const err = expectThrow({ ...minimalValid, MAX_OUTPUT_TOKENS_CEILING: "abc" });
    expect(err.message).toContain("MAX_OUTPUT_TOKENS_CEILING");
  });

  // Same coverage spot-check for REQUEST_TIMEOUT_MS — same schema branch
  it("coerces and accepts a numeric string REQUEST_TIMEOUT_MS", () => {
    const env = parseEnv({ ...minimalValid, REQUEST_TIMEOUT_MS: "30000" });
    expect(env.REQUEST_TIMEOUT_MS).toBe(30_000);
  });
});

describe("parseEnv — secret redaction", () => {
  // B17: input value sentinel never appears in error message
  it("does not echo input values in error messages (sentinel not leaked)", () => {
    const sentinel = "secret-leak-marker-xyz-1234567890";
    const err = expectThrow({
      OPENAI_API_KEY: sentinel,
      // RELAY_AUTH_TOKEN missing on purpose → triggers an error path that
      // could leak OPENAI_API_KEY's value if zod's `received`/`input` were
      // included in the formatted message.
    });
    expect(err.message).not.toContain(sentinel);
    // Defense in depth: also check for substrings of the sentinel.
    expect(err.message).not.toContain("secret-leak-marker");
    expect(err.message).not.toContain("1234567890");
  });

  // B18: failing key path IS included in error message
  it("includes the failing key path in the error message", () => {
    const sentinel = "another-secret-zzz";
    const err = expectThrow({
      OPENAI_API_KEY: sentinel,
      // RELAY_AUTH_TOKEN missing.
    });
    expect(err.message).toContain("RELAY_AUTH_TOKEN");
    // Sanity: the prefix is present so consumers can grep for it.
    expect(err.message).toContain("Invalid environment");
  });

  // Belt-and-suspenders: the same sentinel-leak guarantee for the other
  // secret-class env var (RELAY_AUTH_TOKEN) — failing input value must not
  // appear in the message even when its own validation triggers the error.
  it("does not echo RELAY_AUTH_TOKEN value when it fails its own length check", () => {
    // 31 ASCII bytes — one byte under the floor, triggers the byte-length
    // refinement. The sentinel substring is something we can grep for in the
    // error message to prove the value is not leaked.
    const sentinel = "short-secret-leak-marker-abcdef"; // 31 bytes
    expect(Buffer.byteLength(sentinel, "utf8")).toBe(31);
    const err = expectThrow({ OPENAI_API_KEY: "k", RELAY_AUTH_TOKEN: sentinel });
    expect(err.message).not.toContain(sentinel);
    expect(err.message).not.toContain("short-secret-leak-marker");
    expect(err.message).toContain("RELAY_AUTH_TOKEN");
    expect(err.message).toContain("at least 32 bytes");
  });
});
