// Bearer-token verification for the MCP route (#3).
//
// `verifyToken` is the contract `mcp-handler`'s `withMcpAuth` consumes. It
// validates the `Authorization: Bearer <token>` header value against
// `env.RELAY_AUTH_TOKEN` in constant time using `node:crypto.timingSafeEqual`.
//
// CLAUDE.md §4 absolute prohibitions enforced here:
//   • Never use `===` to compare bearer tokens — `timingSafeEqual` only.
//   • Never log/echo `RELAY_AUTH_TOKEN` (this module emits no diagnostic strings).
//
// Length-mismatch defense: `timingSafeEqual` throws on differing-length
// inputs. We return `undefined` BEFORE calling it when lengths differ —
// this leaks 1 bit (lengths differ), but the alternative (catching the
// throw) leaks more via timing of the exception path. For 32+ byte fixed
// tokens this tradeoff is acceptable (plan §2, OQ-1).

import { timingSafeEqual } from "node:crypto";
import { env } from "./env.js";

export type AuthInfo = {
  clientId: string;
  scopes: readonly string[];
};

export function verifyToken(_req: Request, bearerToken: string | undefined): AuthInfo | undefined {
  if (!bearerToken) return undefined;
  const expected = env.RELAY_AUTH_TOKEN;
  if (!expected) return undefined; // fail-closed
  const a = Buffer.from(bearerToken);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return undefined; // length-oracle defense
  if (!timingSafeEqual(a, b)) return undefined;
  return { clientId: "shared-secret", scopes: ["openai:chat"] };
}
