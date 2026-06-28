# Migration Guide: Plugging In a New Game

This is the guide a 3rd, 4th, or 100th game's owner follows. The goal of the whole architecture is that this list stays short. For how the *first two* games (ZeroDash, Warzone Warriors) are actually integrated today, including every concrete detail this guide generalizes from, see [game/warzonewarriors.md](./game/warzonewarriors.md) and [game/zerodash.md](./game/zerodash.md).

## Option A: Zero-touch (Phase 1 style — recommended for day one)

Use this if the new game already has *any* public, unauthenticated way to discover recent saves/scores — even a simple "leaderboard" or "recent activity" endpoint.

1. **Register the game.** Add one row via `shared/db/seed.js` (or a future admin endpoint):
   ```js
   { key: "highwayhustle", name: "Highway Hustle", integrationMode: "POLLING_ADAPTER", backendBaseUrl: "https://..." }
   ```
2. **Write a tiny adapter.** Copy `services/game-adapters/zerodash-adapter/` to `services/game-adapters/highwayhustle-adapter/`, change `GAME_KEY` and the env var name for the backend URL. If the new game's public endpoints don't match the `{ leaderboard, save-metadata }` shape `startGameSaveAdapter` expects (see `shared/utils/src/polling-adapter.ts`), write a small game-specific fetch+normalize function instead — the only contract that matters is that it ends by calling `nats.publishJson(gameSubject(gameKey, "GAME_SAVED"), payload)` with a payload matching `GameSavedPayloadSchema`.
3. **Add it to `docker-compose.yml`** and the gateway's `GAME_BACKENDS` map in `services/api-gateway/src/main.ts` if you want passthrough proxying through the platform's single origin.
4. Done. `profile-service`, `leaderboard-service`, `achievement-service`, `reward-service`, and `analytics-service` all pick up the new game automatically — none of them have a hardcoded game list.

**Time cost:** under an hour for a game whose backend shape resembles ZeroDash/Warzone's. No code review or deploy required on the game's own repo.

## Option B: Native SDK (Phase 2 — when the game owner is ready to add a few lines)

Use this for real-time events (missions, level-ups) or when polling latency isn't acceptable.

1. The game backend takes a dependency on `@platform/event-bridge` (planned package, not yet built in this skeleton — same shape as `shared/utils/src/nats-client.ts`'s `publishJson`).
2. After whatever the game already does on a relevant action (save, mission complete, level up), add one call:
   ```js
   await eventBridge.emit("MISSION_COMPLETED", { gameKey: "highwayhustle", walletAddress, missionId });
   ```
3. Update the `Game` row: `integrationMode: "NATIVE_SDK"`. The corresponding adapter (if one existed) can be retired.
4. No other service changes — they already subscribe to the wildcard subject, not to a specific game.

## Option C: Managed save pipeline (recommended default for a brand-new game with no backend yet)

Use this if the new game doesn't have its own backend at all yet — skip building one.

1. **Register the game** the same way as Option A (`shared/db/seed.js`), with `integrationMode: "NATIVE_SDK"` (there's nothing to poll).
2. **Define the save shape.** Add a Zod schema for the game's save JSON to `SAVE_DATA_SCHEMAS` in `shared/dto/src/save-data.dto.ts` — see `ZeroDashSaveDataSchema`/`WarzoneSaveDataSchema` for the pattern (built from each game's *real* Unity field names, not guessed).
3. **Point Unity at `save-service`.** `POST /save/<gameKey>` with the save JSON (`Authorization: Bearer <jwt>` from `identity-service`'s login flow), `GET /save/<gameKey>` to load. Unity never encodes, compresses, or talks to 0G Storage directly — `save-service` does all of it. See `architecture/02-service-communication.md` for the full flow, verified live end-to-end including a real Redis-flush recovery test.
4. **Anti-cheat is automatic.** `verification-service` consumes every `SAVE_COMPLETED` event for the new game with zero extra configuration; add a `GameMetadata` row (`anti_cheat_coin_delta_threshold`, `verification_enabled`) only if the defaults don't fit.
5. Done. Same downstream fan-out as Options A/B — profile, leaderboard, achievement, reward, analytics all pick this up via the same `GAME_SAVED` event, since `save-service` publishes it alongside `SAVE_COMPLETED`.

**Time cost:** no backend to build at all for save/load, 0G integration, or anti-cheat — just a save-shape schema and pointing Unity at one HTTP API instead of three (auth, save, 0G). **Tradeoff:** the game's save logic now lives in the platform, not in a repo the game team fully controls — reasonable for a new game, a bigger ask for ZeroDash/Warzone to adopt retroactively (see `architecture/08-migration-roadmap.md` Phase 3 for why that's opt-in and Unity-side, not forced).

**If your client saves frequently** (anything beyond "once per session" or "once per meaningful action"), debounce/coalesce on the client before calling `POST /save` — every call is a real 0G Storage write. Warzone's existing Unity client saves on 17+ different micro-events; that pattern, pointed at this pipeline unmodified, would be far more 0G writes than necessary. See `architecture/09-security-model.md`.

## What you get automatically, either way

- A unified profile entry (`UserGameProgress`) the moment the first `GAME_SAVED` event lands.
- Inclusion in the global leaderboard alongside every other game's players.
- Eligibility for any cross-game achievement whose criteria reference `game_saved`/`mission_completed`/etc. generically (not game-specific criteria, which only fire for the games they're scoped to via `Achievement.gameId`).
- A row in `raw_events` for every event, so the game's activity shows up in platform-wide analytics from day one.

## What you do NOT need to do

- Touch any other game's repository.
- Touch any platform service's source code (config/data changes only, in the common case).
- Re-implement auth, 0G Storage, or save/load — those remain entirely the new game's own responsibility, exactly as ZeroDash and Warzone do it today.
