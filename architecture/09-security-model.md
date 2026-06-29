# Security Model

**Read [00-platform-vision.md](./00-platform-vision.md) first.** Scope: this doc covers the *managed save pipeline* (`save-service` + `verification-service`) — the platform-owned pipeline that's the committed target for every game, including ZeroDash/Warzone once they migrate (see `08-migration-roadmap.md`). The zero-touch path's security (Phase 1/2, where those two games are today) still lives in `zerodash-0g-backend`/`warzone-backend-0g` and is unchanged — see those repos' own SIWE/JWT/anti-rollback logic, which `identity-service` and `api-gateway` deliberately mirror rather than replace.

## The problem this round explicitly targets

With a naive client/server save API, a player can open browser DevTools, intercept the save request, edit the JSON body (`coins: 999999`), and replay it — the backend has no way to tell the difference between "the game sent this" and "the player typed this directly." Both existing repos already partially guard against this (signature-based auth, anti-rollback `saveIndex` checks, async anti-cheat). The managed pipeline closes the same class of bug more directly, since it owns the whole request lifecycle:

## 1. Wallet identity always comes from the verified JWT, never the request body

`save-service`'s `requireAuth` middleware (`services/save-service/src/auth.ts`, identical pattern to `services/api-gateway/src/auth.guard.ts`) sets `req.walletAddress` from a cryptographically verified token. Every database read/write in `save.routes.ts` uses `req.walletAddress`, never anything from `req.body`. A client cannot save to, or load from, any wallet but its own — even if it edits the request body to claim a different `walletAddress`, that field is never read.

## 2. `saveIndex` is always server-computed

Unlike the legacy binary endpoints (which accept an optional client-supplied `X-Save-Index` header as a hint), `save-service` computes the next `saveIndex` itself from the last value stored in Postgres (`existing?.saveIndex ?? -1) + 1`) and never accepts one from the client at all. There is no anti-rollback header to spoof, because there's no client-supplied index in the first place.

## 3. Per-game schema validation rejects tampered shape before anything is encoded

`ZeroDashSaveDataSchema`/`WarzoneSaveDataSchema`, built from the real Unity client field names, reject malformed or out-of-range payloads (negative coins, missing required fields, wrong types) with a 400 before a single byte is encoded or a single 0G Storage write is attempted. **As of Round 4, these schemas live in each game's own per-game service** (`services/games/<game>-service/src/save-schema.ts`), not in shared code — that service is the one validating, before `save-service` (now fully schema-agnostic) ever sees the payload. Verified live: a payload with `coins: -999999` and missing fields was rejected with detailed validation errors before reaching `save-service` at all (see `Knowledge_Base.md`).

## 4. Three-tier validation: structural (sync, always) → semantic/anti-cheat (async, default) → semantic/anti-cheat (sync, "important" events only)

Structural validation (shape, required fields, ranges) is now owned by each game's own per-game service (`services/games/<game>-service/src/save-schema.ts`, Round 4) and runs synchronously, always — cheap, and rejecting garbage before it ever reaches `save-service` or charges a 0G Storage write.

Semantic anti-cheat (plausible coin deltas, TEE-attested verdicts) has two tiers, by design:

- **Default — async, after the fact.** `verification-service` checks every `SAVE_COMPLETED` event once the save has already succeeded, matching the pattern both existing repos already use (anti-cheat never blocks the save response). Right for routine saves, where availability matters more than catching every possible cheat instantly.
- **"Important" events — sync, before commit.** For mission completion, ranked match results, tournament/NFT rewards, and leaderboard submissions — explicitly named by the user as needing stronger guarantees than "flag it after the fact" — the check runs *before* anything is committed or published, and can reject the request outright (`422`) instead of merely flagging it. Two call sites do this today: `save-service`'s `POST /save/:gameKey` when the caller sets `important: true` in the body (the per-game service decides when a save qualifies), and `warzone-service`'s `POST /mission-completed`, which always runs the gate since mission completion is inherently the important-event case. Both reuse the same ported `shared/zg-client` compute client as the async path — not a separate implementation — and both gracefully proceed (`verdict: "SKIPPED"`) with no `ZG_COMPUTE_API_KEY` configured, live-verified.
- **No double-charging.** A save already gated synchronously publishes a non-`"pending"` `computeStatus`; `verification-service`'s async consumer checks for this and skips re-verifying it — otherwise every important save would trigger two separate 0G Compute calls for the same decision.

## 5. RootHash ownership is implicit, not a separate check

A save's `rootHash` is only ever looked up via `UserGameProgress` keyed on `(userId, gameId)`, where `userId` comes from the verified JWT. There's no endpoint that accepts an arbitrary wallet address or rootHash and returns someone else's save — the JWT-derived identity *is* the access control, not a permission check layered on top of a more permissive query.

## 6. Nonce replay protection (unchanged from Round 1, restated for completeness)

`identity-service`'s nonce is single-use (deleted from Redis immediately on any login attempt, success or failure) and TTL'd (5 minutes). Verified live in Round 1: replaying a spent nonce returns 401.

## 7. Security audit logging

**Wired and verified live (Round 3).** `SecurityAuditLog` is written synchronously (not via NATS) by `identity-service` on nonce-replay attempts (`NONCE_INVALID_OR_EXPIRED`), nonce mismatches (`NONCE_MISMATCH`), signature verification failures (`SIGNATURE_VERIFICATION_FAILED`), signature/wallet mismatches (`SIGNATURE_WALLET_MISMATCH`), and successful logins (`LOGIN_SUCCESS`) — synchronous because auth/security events must never be lost to an eventually-consistent event bus. Confirmed live: a real login/replay/bad-signature sequence against a throwaway wallet produced exactly the three expected rows, with `userId` correctly populated only for the successful login (a `User` row need not exist for a failed attempt, so `userId` stays `null` there by design, not by oversight).

## 8. Rate limiting (unchanged from Round 1, restated for completeness)

`express-rate-limit` at the gateway and on `identity-service`'s `/auth` routes — same pattern both existing repos already use.

## 9. Progression integrity: where today's implementation sits on the client-trust spectrum, and where it's headed

`00-platform-vision.md` states the North Star directly: move from "the client states its balance" to "the platform computes its balance." This section is the honest, table-by-table accounting of where each piece of data actually sits on that spectrum today — not a claim that it's already been built.

| Data | Today | Target | Gap |
|---|---|---|---|
| Save shape (required fields, types, ranges) | Validated synchronously, before encoding (§3) | Same — this part is already correct | None |
| `saveIndex` | Server-computed, never client-supplied (§2) | Same — already correct | None |
| The actual coin/XP **value** inside a save | Trusted from the client at save time; checked *after the fact*, asynchronously, by `verification-service`'s anti-cheat heuristic (§4) — a save can succeed and be flagged suspicious only afterward, never blocked up front | Economically-meaningful values (currency, XP — anything that feeds rewards/leaderboards/battle-pass) computed and validated by the platform from reported gameplay events, not accepted as a final number | This is the real, unbuilt gap. Today's anti-cheat is a fraud *detector*, not a progression *authority*. |
| Cosmetic/local save state (character position, UI state, which menu was open) | Trusted from the client, full stop | Same — there's no integrity reason to change this | None — this category was never meant to become server-computed |

**Why this isn't built yet, and why that's the right call for now:** computing currency/XP server-side from discrete events (rather than accepting a client-reported total) is a real data-model change — it means redesigning what a "save" even contains for economically-meaningful fields, not adding a validation rule. Doing that for a save format that's still client-snapshot-shaped end to end (see `08-migration-roadmap.md` Phase 3) would be solving the harder problem before the easier one. The honest sequencing is: finish migrating ZeroDash/Warzone onto the platform-owned save pipeline first (so the platform actually receives every save), then move economically-meaningful fields from snapshot-trusted to event-computed once that's true for real games, not just a managed-pipeline path nothing uses yet.

## Known limitation, documented rather than silently shipped

`BattlePassProgress`'s platform-wide row (`gameId: null`) is looked up with a manual find-then-write instead of Prisma's `upsert()`, because Postgres doesn't enforce uniqueness across multiple `NULL` values in a compound unique index — Prisma's generated types correctly refuse to let `null` participate in that lookup, which is what surfaced this. Today, with a single `reward-service` instance processing NATS messages one at a time in a sequential loop, there's no race. If `reward-service` is ever horizontally scaled to multiple concurrent instances, this needs a real fix (e.g. a non-null sentinel `"PLATFORM"` value instead of `null` for the platform-wide row) before that scale-out — noted here rather than fixed speculatively.

**Already found and fixed, not just a theoretical risk:** `UserGameProgress.metadata` is written by multiple independent consumers (`profile-service` on `GAME_SAVED`, `verification-service` on `SAVE_COMPLETED`/sync gate). One of them — `profile-service` — originally did a blind metadata *replace*, which raced with `verification-service`'s update and intermittently overwrote its verdict back to `"pending"` in live testing during Round 4. Fixed by reading existing metadata and merging before writing, with `verification-service`/`save-service`'s sync-gate fields treated as fields `profile-service` only seeds if nothing has set them yet, never overwrites once set. The general rule this established: **any two consumers writing to the same JSON metadata column must merge, never replace** — a future third consumer touching this column needs to follow the same pattern, not reinvent it.

## Production recommendation, not implemented here (out of scope, Unity-side)

See `architecture/08-migration-roadmap.md` Phase 3: Warzone's Unity client saves on 17+ micro-events plus a 25-second autosave loop. That's a client-side concern (debounce/coalesce before calling the managed pipeline), not something the backend should fake by silently dropping or delaying writes it was asked to make.
