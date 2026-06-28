# Migration Roadmap

**Read [00-platform-vision.md](./00-platform-vision.md) first.** The destination for every game on this platform — ZeroDash and Warzone Warriors included, not just hypothetical future ones — is Phase 3: the game's Unity client sends/receives plain JSON, and the platform owns the entire save pipeline. Phases 1 and 2 are explicitly transitional bridges that exist only because the two real games' repos can't be touched directly today, not parallel, equally-valid permanent architectures. A new game with no existing backend should skip straight to Phase 3 on day one.

No phase requires touching `zerodash-0g-backend` or `warzone-backend-0g`'s *source code* — Phase 3 only ever requires a Unity-side change (point the client at `save-service` instead of the game's own backend), and the game's existing repo simply goes unused for save/load once that happens. Its source stays untouched either way.

## Phase 1 — Zero-touch bridge (shipped, this is where ZeroDash/Warzone are today)

- `zerodash-adapter` / `warzone-adapter` poll each game's existing public `GET /player/leaderboard/decentralized` and `GET /player/save/metadata` endpoints.
- `identity-service` issues JWTs with the exact same claim shape both games' auth middleware already accepts.
- Platform services (`profile`, `leaderboard`, `achievement`, `reward`, `analytics`, `notification`) build the unified experience purely from adapter-sourced events.
- **This is explicitly a compatibility shim, not the architecture we're aiming for.** The game still owns its entire save pipeline; the platform is a passive observer with up to `ADAPTER_POLL_INTERVAL_MS` (default 15s) of lag. It exists only so the platform can deliver value *before* either game migrates, not because polling-and-guessing is how a platform should learn about saves long-term.
- **Risk:** none to the existing repos — they are never called with anything but read-only GETs they already serve publicly, and never receive a deploy.

## Phase 2 — Native SDK (optional intermediate step, NOT a prerequisite for Phase 3)

- Ship `@platform/event-bridge` (a thin wrapper around the same `publishJson` used internally) as an installable package.
- A game adds *one call* after its existing save pipeline / mission-completion logic: `eventBridge.emit('GAME_SAVED', {...})`. This removes the polling lag and unlocks granular events (`mission_completed`, `level_up`) — but **the game still owns its own save infrastructure** (its own 0G Storage client, its own anti-cheat, its own encoding). That's strictly better than Phase 1, but it is *not* the target state described in the vision doc, where the platform owns that infrastructure instead of the game.
- Treat this as a stopgap for a game that wants real-time events sooner than it's ready to do the full Phase 3 migration — not a destination in itself.
- **Risk:** low — a few lines added, fully backward compatible.

## Phase 3 — Full platform ownership of the save pipeline (`save-service` + `verification-service`, built and live-verified — THE TARGET)

- Unity stops encoding/decoding/compressing/anchoring/uploading entirely — it sends and receives plain JSON. `save-service` owns msgpack-encode + gzip-compress + 0G Storage upload/download; `verification-service` owns anti-cheat. This is the literal realization of "games own gameplay, the platform owns everything else."
- **Per-game JSON schemas, not a generic blob.** Built from the real Unity client source (`Assets/.../ZGSaveManager.cs` in both `Metal Black OPS` and `TempleEscape`, read-only — see `docs/repository-mapping.md`), not guessed: `ZeroDashSaveDataSchema`, `WarzoneSaveDataSchema` in `shared/dto`.
- **This is the committed direction for ZeroDash and Warzone, not just an option held open for hypothetical future games.** What's not yet decided is *when* — that's each game owner's call on timing, and it requires a real Unity-side change (replace the client's `Serialize()`/`Deserialize()` + binary POST/GET with a plain JSON POST/GET against `save-service`, using the same JWT it already has). The platform side is done and tested; the Unity-side migration work for these two specific games has not started.
- **The moment a game completes this migration, its Game Adapter is retired.** There's no reason to keep polling a backend Unity no longer talks to for saves — `save-service` already publishes real-time events itself. This is also what fully closes the 15-second-lag gap from Phase 1, not a separate fix.
- **Production note surfaced by reading the real Unity clients:** Warzone's client re-uploads its *entire* profile on 17+ different micro-events (coin/gem/stamina/medal/ticket pickup, level-up, gun/grenade/rambo upgrade, campaign/quest/achievement/tutorial progress) plus a 25-second autosave loop. Run unmodified through a pipeline that commits every call to 0G Storage, that's a 0G write per coin pickup. **Recommendation, to apply during the migration, not solved by the backend:** Unity-side debounce/coalesce (flush on a short timer or on "significant" events only — closer to how the ZeroDash client already behaves, saving only on game-over). The backend stays correct either way; it just does more 0G writes than necessary until the client is tuned. See `architecture/09-security-model.md`.
- **Risk:** none to the existing repos' source (still untouched, and will remain so — Phase 3 only changes what Unity calls). The real-world risk is entirely in the Unity migration work itself and needs normal QA on that change when it happens.

## Phase 4 — True SSO (RS256, shared verification)

- `identity-service` switches from HS256 (shared-secret) to RS256 (public/private keypair).
- Each game's auth middleware is updated (one more small change) to verify JWTs using the platform's public key instead of its own local secret — true single sign-on where a game never mints or independently verifies a token, it only trusts the platform's signature.
- **This is core to "one identity," not late-stage polish.** Until this lands, "single login" only works in practice by manually pointing each game's `BROWSER_JWT_SECRET` at the same value as the platform's — a config alignment, not real SSO. Worth prioritizing earlier than its phase number implies once more than two games exist.
- **Risk:** low, but requires a coordinated rollout (both games need the public key configured before the switch, with a brief dual-acceptance window).

## Phase 5 — Service/database split (only if and when needed)

- The shared Postgres schema is intentionally not split per service in v1 (see the reasoning in the architecture decisions). If a particular service (most likely `analytics-service`, given `raw_events` grows unboundedly) needs independent scaling:
  1. Stand up a separate database (or swap to a warehouse like ClickHouse/BigQuery) for that table only.
  2. Point only that service's Prisma client (or a dedicated client) at the new store.
  3. Other services that read `raw_events` (none today) would need to switch to calling `analytics-service`'s API instead of querying the table directly — which is also why no other service is given write access to `raw_events` today.
- **Risk:** medium — a real data migration, but isolated to one table/service at a time, never a "big bang" split of the whole schema.

## Beyond Phase 5: where the platform's ownership keeps growing

Not phases with dates, but the explicit direction per `00-platform-vision.md`, so they don't get treated as out-of-scope when the time comes:

- **Anti-cheat unification stays explicitly out of scope.** Even after a game completes Phase 3, its anti-cheat is `verification-service`'s own independent implementation — not a refactor of, or integration with, that game's old `ZeroGCompute.js`. The two were never meant to merge; the old one simply stops being called once Unity stops talking to the old backend.
- **Achievement/reward criteria move from code to data.** One rule engine reading `Achievement.criteria`/`GameMetadata` generically, instead of one hardcoded TypeScript function per rule.
- **Per-game save schema registration becomes self-service.** Today, adding a game's JSON schema means editing `shared/dto`'s static map. At scale, this should be a `GameMetadata` row a game owner submits, not a shared-code change.
- **Progression moves from client-stated to platform-computed**, for economically-meaningful fields specifically (currency, XP) — see the "North Star" in the vision doc. Cosmetic/local save state has no such pressure and can stay a client-reported snapshot indefinitely.
- **The `Game` table grows display metadata** (icon, description, genre, WebGL build location) when there's an actual catalog/browser frontend to serve — not built ahead of need, but the schema should grow toward this rather than be redesigned for it later.

## Non-negotiables across every phase

- The RootHash → 0G Storage retrieval path is never re-implemented or duplicated by the platform. `UserGameProgress.rootHash` is always a mirror, never a second source of truth. In Phase 3, 0G Storage is the *only* place the encoded save content is ever persisted — Postgres holds the pointer, Redis holds a disposable working copy. Verified live, not just asserted: a Redis-flush-then-recover test confirmed the exact original JSON survives losing the cache entirely (see `Knowledge_Base.md`).
- Neither existing repo's *source* is ever modified, in any phase — Phase 3 changes what Unity calls, never what either backend repo contains.
- Every new event type is added to `shared/events/src/schemas.ts` before any service starts publishing or consuming it — schema-first, not "see what shows up on the wire."
