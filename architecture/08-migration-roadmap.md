# Migration Roadmap

Five phases (renumbered in Round 2 to insert the managed save pipeline as its own phase), each independently shippable and each a strict improvement over the last — no phase requires the previous one to be "finished" everywhere, and no phase requires touching `zerodash-0g-backend` or `warzone-backend-0g` until Phase 2, and even then only by a few lines. Phase 3 (managed save pipeline) requires touching *Unity* eventually, never either existing backend repo — and that Unity work is each game's own choice and own timeline, not a platform requirement.

## Phase 1 — Zero-touch (this deliverable)

- `zerodash-adapter` / `warzone-adapter` poll each game's existing public `GET /player/leaderboard/decentralized` and `GET /player/save/metadata` endpoints.
- `identity-service` issues JWTs with the exact same claim shape both games' auth middleware already accepts.
- Platform services (`profile`, `leaderboard`, `achievement`, `reward`, `analytics`, `notification`) build the unified experience purely from adapter-sourced events.
- **Risk:** none to the existing repos — they are never called with anything but read-only GETs they already serve publicly, and never receive a deploy.
- **Limitation:** save-to-platform-visibility latency is bounded by `ADAPTER_POLL_INTERVAL_MS` (default 15s), and only the events derivable from the two public endpoints exist (`game_saved` — no granular `mission_completed`/`level_up` yet, since neither repo exposes that on a public route today).

## Phase 2 — Native SDK (opt-in, per game, whenever the team is ready)

- Ship `@platform/event-bridge` (a thin wrapper around the same `publishJson` used internally) as an installable package.
- A game adds *one call* after its existing save pipeline / mission-completion logic, e.g. inside `zgController.js`'s background pipeline: `eventBridge.emit('GAME_SAVED', {...})`. The 0G Storage/Chain/DA/Compute flow is untouched — this is additive, not a refactor.
- Once a game's SDK integration is live, retire its adapter (set `Game.integrationMode = NATIVE_SDK`) — instant events, no polling latency, and access to whatever granular events the game chooses to emit (`mission_completed`, `level_up`, etc.).
- **Risk:** low — a few lines added, fully backward compatible (the game keeps working exactly as before if the event-bridge call fails or is removed).

## Phase 3 — Managed save pipeline (`save-service` + `verification-service`, built and live-verified this round)

- Unity stops encoding/decoding/compressing entirely — it sends and receives plain JSON. `save-service` owns msgpack-encode + gzip-compress + 0G Storage upload/download; `verification-service` owns anti-cheat (ported from `ZeroGCompute.js`).
- **Per-game JSON schemas, not a generic blob.** Built from the real Unity client source (`Assets/.../ZGSaveManager.cs` in both `Metal Black OPS` and `TempleEscape`, read-only — see `docs/repository-mapping.md`), not guessed: `ZeroDashSaveDataSchema`, `WarzoneSaveDataSchema` in `shared/dto`.
- **Who uses this, and when:** any new game built directly on the platform uses this from day one. For ZeroDash/Warzone specifically, this is opt-in and requires a Unity-side change (skip the client's own `Serialize()`/`Deserialize()` calls, POST/GET JSON instead of `application/octet-stream`) — that Unity change is each game's own choice, on each game's own timeline, and is not made by this platform. Until a game opts in, it keeps using Phase 1/2 exactly as today.
- **Production note surfaced by reading the real Unity clients:** Warzone's client re-uploads its *entire* profile on 17+ different micro-events (coin/gem/stamina/medal/ticket pickup, level-up, gun/grenade/rambo upgrade, campaign/quest/achievement/tutorial progress) plus a 25-second autosave loop. Run unmodified through a pipeline that commits every call to 0G Storage, that's a 0G write per coin pickup. **Recommendation, not solved here:** Unity-side debounce/coalesce (flush on a short timer or on "significant" events only — closer to how the ZeroDash client already behaves, saving only on game-over). The backend stays correct either way; it just does more 0G writes than necessary until the client is tuned. See `architecture/09-security-model.md`.
- **Risk:** none to the existing repos (still untouched); the only risk is in the *Unity* change a game owner would later choose to make, on their own schedule.

## Phase 4 — True SSO (RS256, shared verification)

- `identity-service` switches from HS256 (shared-secret) to RS256 (public/private keypair).
- Each game's auth middleware is updated (one more small change) to verify JWTs using the platform's public key instead of its own local secret — true single sign-on where a game never mints or independently verifies a token, it only trusts the platform's signature.
- **Risk:** low, but requires a coordinated rollout (both games need the public key configured before the switch, with a brief dual-acceptance window).

## Phase 5 — Service/database split (only if and when needed)

- The shared Postgres schema is intentionally not split per service in v1 (see the reasoning in the architecture decisions). If a particular service (most likely `analytics-service`, given `raw_events` grows unboundedly) needs independent scaling:
  1. Stand up a separate database (or swap to a warehouse like ClickHouse/BigQuery) for that table only.
  2. Point only that service's Prisma client (or a dedicated client) at the new store.
  3. Other services that read `raw_events` (none today) would need to switch to calling `analytics-service`'s API instead of querying the table directly — which is also why no other service is given write access to `raw_events` today.
- **Risk:** medium — a real data migration, but isolated to one table/service at a time, never a "big bang" split of the whole schema.

## Non-negotiables across every phase

- The RootHash → 0G Storage retrieval path is never re-implemented or duplicated by the platform. `UserGameProgress.rootHash` is always a mirror, never a second source of truth. In Phase 3, 0G Storage is the *only* place the encoded save content is ever persisted — Postgres holds the pointer, Redis holds a disposable working copy. Verified live, not just asserted: a Redis-flush-then-recover test confirmed the exact original JSON survives losing the cache entirely (see `Knowledge_Base.md`).
- Neither existing repo is modified in Phase 1. Phase 2 changes are additive only, reviewed and merged by whoever owns each game repo, on their own timeline. Phase 3 never touches either existing backend repo at all — only Unity, and only if/when a game owner chooses to.
- Every new event type is added to `shared/events/src/schemas.ts` before any service starts publishing or consuming it — schema-first, not "see what shows up on the wire."
