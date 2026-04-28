## Summary

<!-- 1-3 sentence description of the change. The "why" (motivation) is required;
the "what" should be evident from the diff. -->

Closes #<issue-number>

## Verify Commands output

<!-- Paste the output of these four commands. Required by CLAUDE.md §8. -->

```
$ pnpm typecheck
...

$ pnpm lint
...

$ pnpm build
...

$ pnpm test
...
```

## MCP Inspector verification (per `doc/QA-MCP-INSPECTOR.md`)

For non-trivial code changes, run the Inspector procedure and tick each scenario
that passed. For docs-only or CI-config-only PRs, mark **N/A — non-runtime change**.

- [ ] C1 — `tools/list` exposes a single `openai_chat` tool with input schema
- [ ] C2 — `openai_chat` happy path returns text + usage metadata
- [ ] C3 — Allowlist reject (model not in `MODEL_ALLOWLIST`) returns error
- [ ] C4 — `max_tokens` clamp succeeds without error
- [ ] C5 — Wrong bearer returns 401 + `WWW-Authenticate: Bearer`
- [ ] C6 — Cancellation aborts the upstream call

> N/A:
> <reason if all six are skipped>

## v1 non-goal self-check

The change must NOT introduce items deferred to v2 (see
[`doc/ARCHITECTURE.md` §11](../doc/ARCHITECTURE.md#11-future-work-v2-backlog) and
[`CLAUDE.md` §10](../CLAUDE.md#10-non-goals-v1)).

- [ ] No Responses API usage
- [ ] No embeddings / image tools
- [ ] No OAuth 2.1 / DCR
- [ ] No rate limiting (Upstash, etc.)
- [ ] No daily budget counters
- [ ] No external observability (Sentry, OTel, Axiom)
- [ ] No SSE transport / Redis
- [ ] No additional MCP routes (single `app/api/[transport]/route.ts` only)

## Notes for reviewer

<!-- Anything the reviewer should pay attention to: deviations from the plan,
SSOT drift, follow-ups deferred to other issues, etc. Optional. -->
