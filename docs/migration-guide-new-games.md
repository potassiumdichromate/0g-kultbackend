# Migration Guide: Plugging In a New Game

**Read [`../architecture/00-platform-vision.md`](../architecture/00-platform-vision.md) first.** The platform owns identity, the save pipeline, security, cross-game progression, achievements, rewards, and analytics — a game owns gameplay, rendering, input, and local logic. The options below are ordered by how much of that ownership the game keeps versus hands to the platform; the *recommended* path hands over the most.

For how the *first two* games (ZeroDash, Warzone Warriors) are actually integrated today, and their path onto the platform, see [game/warzonewarriors.md](./game/warzonewarriors.md) and [game/zerodash.md](./game/zerodash.md).

## Recommended: full platform ownership (managed save pipeline)

**Use this for any new game, full stop — and it's the migration target for ZeroDash/Warzone too, not just new games.** Unity sends/receives plain JSON; the platform owns encoding, compression, 0G Storage, validation, and anti-cheat. There is no game backend to build, deploy, or secure for save/load at all.

1. **Register the game** (`shared/db/seed.js` or a future admin endpoint), with `integrationMode: "NATIVE_SDK"` (there's nothing to poll — the platform receives saves directly).
2. **Define the save shape.** Add a Zod schema for the game's save JSON to `SAVE_DATA_SCHEMAS` in `shared/dto/src/save-data.dto.ts` — see `ZeroDashSaveDataSchema`/`WarzoneSaveDataSchema` for the pattern (built from each game's *real* Unity field names, not guessed). This is the one piece of the save pipeline that's inherently game-specific — describing the shape of *this game's* state — and it's intentionally the only thing a game contributes here.
3. **Point Unity at `save-service`.** `POST /save/<gameKey>` with the save JSON (`Authorization: Bearer <jwt>` from `identity-service`'s login flow), `GET /save/<gameKey>` to load. Unity never encodes, compresses, or talks to 0G Storage directly — `save-service` does all of it. See `architecture/02-service-communication.md` for the full flow, verified live end-to-end including a real Redis-flush recovery test.
4. **Anti-cheat is automatic.** `verification-service` consumes every `SAVE_COMPLETED` event for the new game with zero extra configuration; add a `GameMetadata` row (`anti_cheat_coin_delta_threshold`, `verification_enabled`) only if the defaults don't fit.
5. Done. `profile-service`, `leaderboard-service`, `achievement-service`, `reward-service`, and `analytics-service` all pick this up via the same `GAME_SAVED` event, since `save-service` publishes it alongside `SAVE_COMPLETED` — none of them have a hardcoded game list.

**Time cost:** no backend to build at all for save/load, 0G integration, or anti-cheat — just a save-shape schema and pointing Unity at one HTTP API instead of three (auth, save, 0G). For ZeroDash/Warzone specifically, getting here means a Unity-side change to stop calling the old backend's binary endpoints — that's the committed direction (see `architecture/08-migration-roadmap.md` Phase 3), with timing up to each game's owner, not a forced cutover.

**If your client saves frequently** (anything beyond "once per session" or "once per meaningful action"), debounce/coalesce on the client before calling `POST /save` — every call is a real 0G Storage write. Warzone's existing Unity client saves on 17+ different micro-events; that pattern, pointed at this pipeline unmodified, would be far more 0G writes than necessary. See `architecture/09-security-model.md`.

## Bridge option: zero-touch adapter (only if the game already has its own backend it isn't ready to retire)

This is how ZeroDash and Warzone Warriors are integrated *today* — a compatibility shim for a game with existing save/load infrastructure, not the architecture to reach for if you're starting from nothing.

1. **Register the game.** Add one row via `shared/db/seed.js`:
   ```js
   { key: "highwayhustle", name: "Highway Hustle", integrationMode: "POLLING_ADAPTER", backendBaseUrl: "https://..." }
   ```
2. **Write a tiny adapter.** Copy `services/game-adapters/zerodash-adapter/`, change `GAME_KEY` and the backend URL env var. If the game's public endpoints don't match the `{ leaderboard, save-metadata }` shape `startGameSaveAdapter` expects (see `shared/utils/src/polling-adapter.ts`), write a small game-specific fetch+normalize function instead — the only contract that matters is that it ends by calling `nats.publishJson(gameSubject(gameKey, "GAME_SAVED"), payload)` matching `GameSavedPayloadSchema`.
3. **Add it to `docker-compose.yml`** and the gateway's `GAME_BACKENDS` map if you want passthrough proxying through the platform's single origin.
4. Done, with the same downstream fan-out as above — but with up to `ADAPTER_POLL_INTERVAL_MS` of lag, and the game still owns (and must secure and maintain) its entire save/auth/0G stack itself.

**Plan to retire this once the game migrates to the recommended path above** — it has no remaining job once `save-service` is receiving that game's saves directly.

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
