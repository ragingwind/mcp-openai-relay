// Seeds process.env with minimal valid values BEFORE lib/env.ts loads in tests.
// `??=` so an externally provided value (CI secret) is not overwritten.
process.env.OPENAI_API_KEY ??= "test-openai-api-key";
process.env.RELAY_AUTH_TOKEN ??= "x".repeat(32);
