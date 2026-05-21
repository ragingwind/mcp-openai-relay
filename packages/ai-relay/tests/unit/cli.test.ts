// Argv parser tests for `ai-relay <provider> <tool> [flags] [input]`.

import { describe, expect, it } from "vitest";
import { parseArgv, parseMcpArgv, UsageError } from "../../src/bin/parse.js";

describe("parseArgv — basic shape", () => {
  it("P1: <provider> <tool> <input> → ParsedInvocation", () => {
    const out = parseArgv(["openai", "chat-completions", "hi"]);
    expect(out.provider).toBe("openai");
    expect(out.tool).toBe("chat-completions");
    expect(out.flags.model).toBeUndefined();
    expect(out.positional).toBe("hi");
    expect(out.help).toBe(false);
    expect(out.version).toBe(false);
  });

  it("P2: <provider> <tool> with no input is valid (stdin will be read by runner)", () => {
    const out = parseArgv(["openai", "chat-completions"]);
    expect(out.provider).toBe("openai");
    expect(out.tool).toBe("chat-completions");
    expect(out.positional).toBeUndefined();
  });

  it("P3: -m <model> captured as flag", () => {
    const out = parseArgv(["openai", "chat-completions", "-m", "gpt-4o-mini", "hi"]);
    expect(out.flags.model).toBe("gpt-4o-mini");
    expect(out.positional).toBe("hi");
  });

  it("P4: long --model accepted", () => {
    const out = parseArgv(["openai", "chat-completions", "--model", "gpt-4o", "hi"]);
    expect(out.flags.model).toBe("gpt-4o");
  });

  it("P5: --model=value inline form works", () => {
    const out = parseArgv(["openai", "chat-completions", "--model=gpt-4o-mini", "hi"]);
    expect(out.flags.model).toBe("gpt-4o-mini");
  });

  it("P6: numeric flags (--max-tokens, --timeout) parse to integers", () => {
    const out = parseArgv([
      "openai",
      "chat-completions",
      "--max-tokens",
      "1024",
      "--timeout",
      "30000",
      "hi",
    ]);
    expect(out.flags["max-tokens"]).toBe(1024);
    expect(out.flags.timeout).toBe(30000);
  });

  it("P10: --env path captured", () => {
    const out = parseArgv(["openai", "chat-completions", "--env", "./prod.env", "hi"]);
    expect(out.flags.env).toBe("./prod.env");
  });

  it("P11: --api-key and --base-url captured", () => {
    const out = parseArgv([
      "openai",
      "chat-completions",
      "--api-key",
      "sk-secret",
      "--base-url",
      "https://example.test/v1",
      "hi",
    ]);
    expect(out.flags["api-key"]).toBe("sk-secret");
    expect(out.flags["base-url"]).toBe("https://example.test/v1");
  });

  it("P12: -m sets model", () => {
    const out = parseArgv(["openai", "chat-completions", "-m", "gpt-4o", "hi"]);
    expect(out.flags.model).toBe("gpt-4o");
    expect(out.positional).toBe("hi");
  });
});

describe("parseArgv — help/version short-circuit", () => {
  it("P1: -h short-circuits without requiring positionals", () => {
    expect(parseArgv(["-h"]).help).toBe(true);
    expect(parseArgv(["--help"]).help).toBe(true);
  });

  it("P2: -V short-circuits without requiring positionals", () => {
    expect(parseArgv(["-V"]).version).toBe(true);
    expect(parseArgv(["--version"]).version).toBe(true);
  });
});

describe("parseArgv — verbose flag", () => {
  it("P1: --verbose long flag sets verbose=true", () => {
    const out = parseArgv(["openai", "chat-completions", "--verbose", "-m", "gpt-4o-mini", "hi"]);
    expect(out.verbose).toBe(true);
    expect(out.flags.model).toBe("gpt-4o-mini");
    expect(out.positional).toBe("hi");
  });

  it("P2: -v short flag sets verbose=true", () => {
    const out = parseArgv(["openai", "chat-completions", "-v", "-m", "gpt-4o-mini", "hi"]);
    expect(out.verbose).toBe(true);
  });

  it("P3: omitted verbose flag → verbose=false", () => {
    const out = parseArgv(["openai", "chat-completions", "-m", "gpt-4o-mini", "hi"]);
    expect(out.verbose).toBe(false);
  });

  it("P4: -v is a boolean — does NOT consume the next token as a value", () => {
    const out = parseArgv(["openai", "chat-completions", "-v", "hi"]);
    expect(out.verbose).toBe(true);
    expect(out.positional).toBe("hi");
  });
});

describe("parseMcpArgv — verbose flag", () => {
  it("P1: --verbose long flag sets verbose=true", () => {
    const out = parseMcpArgv(["openai", "--verbose"]);
    expect(out.verbose).toBe(true);
    expect(out.provider).toBe("openai");
  });

  it("P2: -v short flag sets verbose=true", () => {
    const out = parseMcpArgv(["openai", "-v"]);
    expect(out.verbose).toBe(true);
  });

  it("P3: omitted verbose flag → verbose=false", () => {
    const out = parseMcpArgv(["openai"]);
    expect(out.verbose).toBe(false);
  });
});

describe("parseArgv — error paths", () => {
  it("D1: empty argv → usage error", () => {
    expect(() => parseArgv([])).toThrow(UsageError);
    expect(() => parseArgv([])).toThrow(/usage: ai-relay/);
  });

  it("D1b: single positional (provider only) rejected — tool is required", () => {
    expect(() => parseArgv(["openai"])).toThrow(/usage: ai-relay/);
  });

  it("D2: unknown long flag → UsageError", () => {
    expect(() => parseArgv(["openai", "chat-completions", "--bogus", "x"])).toThrow(
      /unknown flag: --bogus/,
    );
  });

  it("D3: unknown short flag → UsageError", () => {
    expect(() => parseArgv(["openai", "chat-completions", "-x"])).toThrow(/unknown flag: -x/);
  });

  it("D4: --max-tokens with non-integer value rejected", () => {
    expect(() => parseArgv(["openai", "chat-completions", "--max-tokens", "abc", "hi"])).toThrow(
      /--max-tokens must be a positive integer/,
    );
  });

  it("D5: --max-tokens with zero rejected", () => {
    expect(() => parseArgv(["openai", "chat-completions", "--max-tokens", "0", "hi"])).toThrow(
      /must be a positive integer/,
    );
  });

  it("D6: more than one positional input rejected (model is no longer a positional)", () => {
    expect(() => parseArgv(["openai", "chat-completions", "gpt-4o-mini", "hi"])).toThrow(
      /at most one positional input/,
    );
  });

  it("D7: flag without value at end of argv rejected", () => {
    expect(() => parseArgv(["openai", "chat-completions", "--api-key"])).toThrow(
      /--api-key requires a value/,
    );
  });

  it("D8: -m without value rejected", () => {
    expect(() => parseArgv(["openai", "chat-completions", "-m"])).toThrow(/-m requires a value/);
  });

  it("D9: --model without value rejected", () => {
    expect(() => parseArgv(["openai", "chat-completions", "--model"])).toThrow(
      /--model requires a value/,
    );
  });
});
