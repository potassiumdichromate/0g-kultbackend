# Security Model

Scope: this doc covers the *managed save pipeline* (`save-service` + `verification-service`, Round 2). The zero-touch path's security (Phase 1/2) already lives in `zerodash-0g-backend`/`warzone-backend-0g` and is unchanged — see those repos' own SIWE/JWT/anti-rollback logic, which `identity-service` and `api-gateway` deliberately mirror rather than replace.

## The problem this round explicitly targets

With a naive client/server save API, a player can open browser DevTools, intercept the save request, edit the JSON body (`coins: 999999`), and replay it — the backend has no way to tell the difference between "the game sent this" and "the player typed this directly." Both existing repos already partially guard against this (signature-based auth, anti-rollback `saveIndex` checks, async anti-cheat). The managed pipeline closes the same class of bug more directly, since it owns the whole request lifecycle:

## 1. Wallet identity always comes from the verified JWT, never the request body

`save-service`'s `requireAuth` middleware (`services/save-service/src/auth.ts`, identical pattern to `services/api-gateway/src/auth.guard.ts`) sets `req.walletAddress` from a cryptographically verified token. Every database read/write in `save.routes.ts` uses `req.walletAddress`, never anything from `req.body`. A client cannot save to, or load from, any wallet but its own — even if it edits the request body to claim a different `walletAddress`, that field is never read.

## 2. `saveIndex` is always server-computed

Unlike the legacy binary endpoints (which accept an optional client-supplied `X-Save-Index` header as a hint), `save-service` computes the next `saveIndex` itself from the last value stored in Postgres (`existing?.saveIndex ?? -1) + 1`) and never accepts one from the client at all. There is no anti-rollback header to spoof, because there's no client-supplied index in the first place.

## 3. Per-game schema validation rejects tampered shape before anything is encoded

`ZeroDashSaveDataSchema`/`WarzoneSaveDataSchema` (`shared/dto/src/save-data.dto.ts`), built from the real Unity client field names, reject malformed or out-of-range payloads (negative coins, missing required fields, wrong types) with a 400 before a single byte is encoded or a single 0G Storage write is attempted. Verified live: a payload with `coins: -999999` and missing fields was rejected with detailed validation errors (see `Knowledge_Base.md`).

## 4. Two-tier validation: structural (sync) vs. semantic/anti-cheat (async)

`save-service` does only structural validation synchronously (shape, required fields, ranges) — enough to reject garbage immediately without adding 0G Compute latency to every save's response time. `verification-service` does semantic anti-cheat validation (plausible coin deltas, TEE-attested verdicts) asynchronously, after the save has already succeeded — matching the pattern both existing repos already use (anti-cheat never blocks the save response). The two are deliberately separated: structural validation is cheap and must never be skipped; semantic validation is expensive (an LLM call) and is conditionally triggered.

## 5. RootHash ownership is implicit, not a separate check

A save's `rootHash` is only ever looked up via `UserGameProgress` keyed on `(userId, gameId)`, where `userId` comes from the verified JWT. There's no endpoint that accepts an arbitrary wallet address or rootHash and returns someone else's save — the JWT-derived identity *is* the access control, not a permission check layered on top of a more permissive query.

## 6. Nonce replay protection (unchanged from Round 1, restated for completeness)

`identity-service`'s nonce is single-use (deleted from Redis immediately on any login attempt, success or failure) and TTL'd (5 minutes). Verified live in Round 1: replaying a spent nonce returns 401.

## 7. Security audit logging

`SecurityAuditLog` (Postgres) is written **synchronously** by `identity-service` — not via NATS — on nonce-replay attempts, signature verification failures, and successful logins. Synchronous because auth/security events must never be lost to an eventually-consistent event bus; if the write fails, the request fails loudly rather than silently dropping the audit trail.

## 8. Rate limiting (unchanged from Round 1, restated for completeness)

`express-rate-limit` at the gateway and on `identity-service`'s `/auth` routes — same pattern both existing repos already use.

## Known limitation, documented rather than silently shipped

`BattlePassProgress`'s platform-wide row (`gameId: null`) is looked up with a manual find-then-write instead of Prisma's `upsert()`, because Postgres doesn't enforce uniqueness across multiple `NULL` values in a compound unique index — Prisma's generated types correctly refuse to let `null` participate in that lookup, which is what surfaced this. Today, with a single `reward-service` instance processing NATS messages one at a time in a sequential loop, there's no race. If `reward-service` is ever horizontally scaled to multiple concurrent instances, this needs a real fix (e.g. a non-null sentinel `"PLATFORM"` value instead of `null` for the platform-wide row) before that scale-out — noted here rather than fixed speculatively.

## Production recommendation, not implemented here (out of scope, Unity-side)

See `architecture/08-migration-roadmap.md` Phase 3: Warzone's Unity client saves on 17+ micro-events plus a 25-second autosave loop. That's a client-side concern (debounce/coalesce before calling the managed pipeline), not something the backend should fake by silently dropping or delaying writes it was asked to make.
