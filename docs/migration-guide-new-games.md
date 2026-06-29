# Migration Guide: Plugging In a New Game

**Read [`../architecture/00-platform-vision.md`](../architecture/00-platform-vision.md) first.** The platform owns identity, the save pipeline, security, cross-game progression, achievements, rewards, and analytics — a game owns gameplay, rendering, input, and local logic. The options below are ordered by how much of that ownership the game keeps versus hands to the platform; the *recommended* path hands over the most.

For how the *first two* games (ZeroDash, Warzone Warriors) are actually integrated today, and their path onto the platform, see [game/warzonewarriors.md](./game/warzonewarriors.md) and [game/zerodash.md](./game/zerodash.md).

## Recommended: full platform ownership (managed save pipeline)

**Use this for any new game, full stop — and it's the migration target for ZeroDash/Warzone too, not just new games.** Unity sends/receives plain JSON; the platform owns encoding, compression, 0G Storage, validation, and anti-cheat. There is no shared infrastructure to build, deploy, or secure for save/load at all — the only thing you build is a thin per-game service.

1. **Register the game** (`shared/db/seed.js` or a future admin endpoint), with `integrationMode: "NATIVE_SDK"` (there's nothing to poll — the platform receives saves directly).
2. **Build a thin per-game service.** Copy `services/games/zerodash-service/` (the simpler of the two reference implementations — `warzone-service` additionally shows the gameplay-event pattern, see step 5) to `services/games/<yourgame>-service/`. This service is Unity's actual front door — not `save-service` directly.
3. **Define the save shape inside that service**, not in shared code: `src/save-schema.ts`, a Zod schema built from your game's *real* client field names, not guessed — see either reference implementation's `save-schema.ts`. This is the one piece of the save pipeline that's inherently game-specific, and it's intentionally the only thing a game contributes to the pipeline itself.
4. **Point Unity at your per-game service**, never at `save-service`. `POST /save` with the save JSON (`Authorization: Bearer <jwt>` from `identity-service`'s login flow), `GET /save` to load. Your service validates, then internally calls `save-service`'s schema-agnostic `POST/GET /save/<gameKey>` — Unity never encodes, compresses, or talks to 0G Storage directly, and never even knows `save-service` exists. See `architecture/02-service-communication.md` for the full flow, verified live end-to-end including a real Redis-flush recovery test.
5. **If your game has its own gameplay-event vocabulary** (mission completion, race finished, level completed — anything beyond "a save happened"), add an endpoint for it in your per-game service, following `warzone-service/src/mission.routes.ts`: validate, optionally gate synchronously through 0G Compute TEE verification for high-value events (see step 7), then publish a generic NATS event (`MissionCompletedPayloadSchema` or a new schema in `shared/events` if your event type doesn't fit an existing one) with your game-specific fields tucked into `metrics` — every downstream service reacts to the generic event without ever knowing your field names.
6. **Anti-cheat is automatic for the default case.** `verification-service` consumes every `SAVE_COMPLETED` event for the new game with zero extra configuration; add a `GameMetadata` row (`anti_cheat_coin_delta_threshold`, `verification_enabled`) only if the defaults don't fit.
7. **For high-value events specifically** (mission completion, ranked results, tournament/NFT rewards, leaderboard submissions), gate them synchronously instead: pass `important: true` in your save call, or call `@platform/zg-client`'s `createComputeClient().runAntiCheat(...)` directly in your gameplay-event endpoint before publishing (see `warzone-service/src/mission.routes.ts`). This can reject the request with a `422` before anything is committed — stronger than the default async flag-after-the-fact path. See `architecture/09-security-model.md`.
8. Done. `profile-service`, `leaderboard-service`, `achievement-service`, `reward-service`, and `analytics-service` all pick this up via the same generic events — none of them have a hardcoded game list.

**Time cost:** no shared infrastructure to build for save/load, 0G integration, or anti-cheat — just a thin per-game service (save schema + optional gameplay-event endpoints) and pointing Unity at one HTTP API instead of three (auth, save, 0G). For ZeroDash/Warzone specifically, getting here means a Unity-side change to stop calling the old backend's binary endpoints — that's the committed direction (see `architecture/08-migration-roadmap.md` Phase 3), with timing up to each game's owner, not a forced cutover.

**If your client saves frequently** (anything beyond "once per session" or "once per meaningful action"), debounce/coalesce on the client before calling `POST /save` — every call is a real 0G Storage write. Warzone's existing Unity client saves on 17+ different micro-events; that pattern, pointed at this pipeline unmodified, would be far more 0G writes than necessary. See `architecture/09-security-model.md`.

## Bridge option: zero-touch adapter (only if the game already has its own backend it isn't ready to retire)

This is how ZeroDash and Warzone Warriors are integrated *today* — a compatibility shim for a game with existing save/load infrastructure, not the architecture to reach for if you're starting from nothing.

1. **Register the game.** Add one row via `shared/db/seed.js`:
   ```js
   { key: "highwayhustle", name: "Highway Hustle", integrationMode: "POLLING_ADAPTER", backendBaseUrl: "https://..." }
   ```
2. **That's it — no new service.** `services/game-adapters/sync-service` reads every `Game` row with `integrationMode: "POLLING_ADAPTER"` from Postgres on a refresh interval and starts polling it automatically using `startGameSaveAdapter` (see `shared/utils/src/polling-adapter.ts`). If the game's public endpoints don't match the `{ leaderboard, save-metadata }` shape that function expects, that's the one place you'd write a small game-specific fetch+normalize function — the only contract that matters is that it ends by calling `nats.publishJson(gameSubject(gameKey, "GAME_SAVED"), payload)` matching `GameSavedPayloadSchema`. (Round 1/2 shipped this as one standalone adapter service per game; Round 3 collapsed that into the single config-driven `sync-service` described here — see `architecture/00-platform-vision.md`.)
3. **Add it to the gateway's `GAME_BACKENDS` map** if you want passthrough proxying through the platform's single origin.
4. Done, with the same downstream fan-out as above — but with up to `ADAPTER_POLL_INTERVAL_MS` of lag, and the game still owns (and must secure and maintain) its entire save/auth/0G stack itself.

**Retiring this once the game migrates to the recommended path above is also just a database update** — set `integrationMode` to anything other than `POLLING_ADAPTER` and `sync-service` stops polling that game on its next refresh cycle, with no redeploy. Verified live (see `Knowledge_Base.md`): flipping `warzone`'s `integrationMode` to `NATIVE_SDK` and back made `sync-service` drop and re-add it within one refresh interval.

## Optional intermediate step: Native SDK (real-time events without a full migration)

For a game that wants real-time events sooner than it's ready to hand over its whole save pipeline. The game backend takes a dependency on `@platform/event-bridge` (planned package, not yet built) and adds one call after its existing save/mission logic:

```js
await eventBridge.emit("MISSION_COMPLETED", { gameKey: "highwayhustle", walletAddress, missionId });
```

Update the `Game` row to `integrationMode: "NATIVE_SDK"` and retire the corresponding adapter. This removes polling lag, but the game still owns its own save infrastructure — it's a real improvement over the bridge option, not a substitute for eventually reaching full platform ownership.

## What you get automatically, regardless of which option

- A unified profile entry (`UserGameProgress`) the moment the first `GAME_SAVED` event lands.
- Inclusion in the global leaderboard alongside every other game's players.
- Eligibility for any cross-game achievement whose criteria reference `game_saved`/`mission_completed`/etc. generically (not game-specific criteria, which only fire for the games they're scoped to via `Achievement.gameId`).
- A row in `raw_events` for every event, so the game's activity shows up in platform-wide analytics from day one.

## What you never need to do, on any option

- Touch any other game's repository or backend.
- Touch any platform service's source code (config/data changes only, in the common case).

## What you still own yourself, *only* if you chose the bridge option

If (and only if) you chose the zero-touch bridge above instead of the recommended managed pipeline: auth, 0G Storage, save/load encoding, and anti-cheat remain entirely your own backend's responsibility, exactly as ZeroDash and Warzone do it today — the platform is a read-only observer of your existing infrastructure, not a replacement for it. On the recommended path, the platform owns all of that instead.
