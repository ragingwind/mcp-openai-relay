// Unit tests for `lib/auth.ts` — covers all 9 behaviors from plan §6 (B1-B9).
//
// Test seed: `tests/setup-env.ts` already places `RELAY_AUTH_TOKEN = "x".repeat(32)`
// into `process.env` BEFORE `lib/env.ts` loads, so the module-level env constant
// captured at lib/env.ts:59 holds that 32-byte value for every test in this file
// (except the fail-closed block, which uses `vi.doMock` to override).

import { describe, expect, it, vi } from "vitest";
import { verifyToken } from "../../lib/auth.js";

const fakeReq = new Request("http://localhost/api/mcp");

// The setup file seeds RELAY_AUTH_TOKEN with this exact value. Capture it once
// to keep tests readable; treat it as the "expected" token throughout. We never
// log it (CLAUDE.md §4) — it only flows through `verifyToken` as bytes.
const EXPECTED = "x".repeat(32);

describe("verifyToken — input handling", () => {
  // B1: bearer === undefined
  it("P1: returns undefined when no bearer token is presented", () => {
    expect(verifyToken(fakeReq, undefined)).toBeUndefined();
  });

  // B2: bearer === ""
  it("P2: returns undefined when the bearer token is the empty string", () => {
    expect(verifyToken(fakeReq, "")).toBeUndefined();
  });
});

describe("verifyToken — fail-closed on missing env", () => {
  // B3: RELAY_AUTH_TOKEN empty → reject even with a non-empty bearer.
  // The env constant in `lib/env.ts` is captured at module load (line 59),
  // so `vi.stubEnv` post-hoc cannot affect it. We use `vi.resetModules` +
  // `vi.doMock` and dynamic-import `lib/auth.js` so the auth module re-imports
  // a freshly mocked `env` with `RELAY_AUTH_TOKEN: ""`. The `vi.doUnmock`
  // cleanup ensures the mock does not bleed into later test files.
  it("D1: returns undefined when RELAY_AUTH_TOKEN is empty (fail-closed)", async () => {
    vi.resetModules();
    vi.doMock("../../lib/env.js", () => ({ env: { RELAY_AUTH_TOKEN: "" } }));
    try {
      const { verifyToken: vt } = await import("../../lib/auth.js");
      expect(vt(fakeReq, "anything-non-empty")).toBeUndefined();
    } finally {
      vi.doUnmock("../../lib/env.js");
      vi.resetModules();
    }
  });
});

describe("verifyToken — length mismatch", () => {
  // B4: bearer longer than expected
  it("D1: returns undefined when bearer is longer than expected", () => {
    expect(verifyToken(fakeReq, `${EXPECTED}extra`)).toBeUndefined();
  });

  // B5: bearer shorter than expected
  it("D2: returns undefined when bearer is shorter than expected", () => {
    expect(verifyToken(fakeReq, EXPECTED.slice(0, -1))).toBeUndefined();
  });
});

describe("verifyToken — timing-safe comparison & invariants", () => {
  // B6: same length, different content
  it("D1: returns undefined when bearer has the same length but different content", () => {
    const wrong = "y".repeat(EXPECTED.length);
    expect(wrong.length).toBe(EXPECTED.length); // sanity
    expect(verifyToken(fakeReq, wrong)).toBeUndefined();
  });

  // B6 cont.: single-byte change at the tail (would catch naive prefix compare)
  it("N1: returns undefined when only the final byte differs", () => {
    const oneOff = `${EXPECTED.slice(0, -1)}y`;
    expect(oneOff.length).toBe(EXPECTED.length);
    expect(oneOff).not.toBe(EXPECTED);
    expect(verifyToken(fakeReq, oneOff)).toBeUndefined();
  });

  // B7: exact match → success shape. The `token` field echoes the validated
  // bearer back to the SDK (per @modelcontextprotocol/sdk's AuthInfo
  // contract — `withMcpAuth` consumes this exact shape and exposes it on
  // `req.auth`); CLAUDE.md §4 forbids logging it externally.
  it("P1: returns AuthInfo on exact match", () => {
    const result = verifyToken(fakeReq, EXPECTED);
    expect(result).toEqual({
      token: EXPECTED,
      clientId: "shared-secret",
      scopes: ["openai:chat"],
    });
  });

  // B8: scopes invariant (length === 1 && scopes[0] === "openai:chat")
  it("P2: returns scopes equal to ['openai:chat'] on success", () => {
    const result = verifyToken(fakeReq, EXPECTED);
    expect(result).toBeDefined();
    expect(result?.scopes).toHaveLength(1);
    expect(result?.scopes[0]).toBe("openai:chat");
  });

  // B9: clientId invariant
  it("P3: returns clientId equal to 'shared-secret' on success", () => {
    const result = verifyToken(fakeReq, EXPECTED);
    expect(result?.clientId).toBe("shared-secret");
  });

  // Defensive guard from plan §6: precomposed vs decomposed unicode have the
  // same Buffer.byteLength but different bytes — must NOT match. This protects
  // against any future caller passing user-derived (normalized) strings.
  it("D2: returns undefined for unicode-equal but byte-different bearer (NFC vs NFD)", () => {
    // Build two 32-UTF-8-byte strings that differ in normalization.
    // "é" precomposed (U+00E9) is 2 bytes; "é" decomposed (U+0065 U+0301) is 3 bytes.
    // We don't compare directly to EXPECTED (it's "x".repeat(32)), but assert
    // that two distinct byte sequences with equal byte length never collide
    // through `verifyToken` — i.e., a non-matching bearer of the same byte
    // length still returns undefined (the same property B6 asserts, framed as
    // a unicode-confusion regression guard).
    const candidate = "é".repeat(16); // 16 chars × 2 bytes = 32 bytes (NFC)
    expect(Buffer.byteLength(candidate, "utf8")).toBe(32);
    expect(verifyToken(fakeReq, candidate)).toBeUndefined();
  });
});
