# Development Guide

Working on a specific game's integration? [game/warzonewarriors.md](./game/warzonewarriors.md) and [game/zerodash.md](./game/zerodash.md) cover each game's backend, Unity client, save format, and exact platform integration path in depth — this doc stays focused on the platform's own dev workflow.

## Prerequisites

- Node.js >= 18.18 (developed against Node 22)
- Docker Desktop (for Postgres, Redis, NATS — and optionally to run the services themselves)

## First-time setup

```sh
cd 0g-kultbrowser
cp .env.example .env             # adjust PLATFORM_JWT_SECRET etc. for real use
cp .env.example shared/db/.env   # Prisma CLI loads .env relative to the schema's package, not the repo root
npm install                      # installs every workspace (shared/* and services/*) in one pass
npm run db:generate              # generates the Prisma client into shared/db/generated/client
```

**Port note:** `docker-compose.yml` maps Postgres/Redis/NATS to non-default host ports (`5434`, `6380`, `4322`/`8322`) because this is exactly the kind of dev machine that already runs other local services on the standard ports (a native PostgreSQL install on 5432, another docker-compose stack's Redis/NATS on 6379/4222) — confirmed the hard way during this project's own verification pass, where the default ports silently routed `prisma migrate dev` into the wrong Postgres instance. `.env.example` already reflects the remapped ports; if your machine has nothing else running on the defaults, feel free to simplify back to `5432`/`6379`/`4222` in both `docker-compose.yml` and `.env.example`.

## Running the infra dependencies only (recommended for day-to-day service development)

```sh
docker compose up -d postgres redis nats
npm run db:migrate -- --name init    # applies shared/db/prisma/schema.prisma to the local Postgres
node shared/db/seed.js                # registers the zerodash/warzone Game rows (run with DATABASE_URL set, or via shared/db/.env)
```

`npm run db:migrate` forwards to `prisma migrate dev` inside `shared/db` — if it prompts interactively for a migration name instead of using the one you passed, run `npx prisma migrate dev --name init` directly inside `shared/db/` instead (the `--` argument-forwarding through nested npm scripts doesn't always reach the underlying CLI).

Then run any individual service against that infra with hot reload:

```sh
npm run dev --workspace=services/identity-service
npm run dev --workspace=services/profile-service
npm run dev --workspace=services/game-adapters/sync-service
```

Each service's `package.json` `dev` script uses `tsx watch`, so edits to its own `src/` reload immediately. If you edit a `shared/*` package, rebuild it once (`npm run build --workspace=shared/utils`) so the compiled `dist/` consumed by services picks up the change — workspaces are linked by symlink but services import the built output, not the TypeScript source.

## Running everything via Docker Compose

```sh
npm run compose:up    # docker compose up --build — builds every service's Dockerfile and starts the full stack
npm run compose:down  # docker compose down -v — stops everything and drops volumes
```

Each service's `Dockerfile` builds from the repo root context (so it can `COPY shared/` in), then narrows `WORKDIR` to the service directory for the final `CMD`.

## Verifying the wiring end to end

This was actually run during the architecture build-out (not just described) — see `Knowledge_Base.md` for the full result. Steps to repeat it:

1. `docker compose up -d postgres redis nats`, then `npx prisma migrate dev --name init` inside `shared/db/`, then `node shared/db/seed.js` (with `DATABASE_URL` set, e.g. via `shared/db/.env`).
2. `npm run dev --workspace=services/identity-service` in one terminal. Confirmed: a throwaway `ethers.Wallet`, signing the returned message, round-trips a 7-day HS256 JWT with `{walletAddress, sub}` claims, and replaying a spent nonce correctly returns 401.
3. `npm run dev --workspace=services/game-adapters/sync-service` — within `ADAPTER_POLL_INTERVAL_MS` it polls the **real, live, public** ZeroDash backend (`https://zerog-zerodash.onrender.com`) and republishes each active player's latest save as a `GAME_SAVED` event with their real `rootHash`. Confirmed: 18 real players' saves were picked up in the first poll cycle. This only ever does read-only GETs against ZeroDash's already-public endpoints — nothing is written there.
4. `npm run dev --workspace=services/profile-service` — `GET http://localhost:3002/profile/<wallet>` returns the unified profile with that game's real `rootHash`/`saveIndex`/`coinSnapshot` mirrored into `UserGameProgress`. Confirmed against real ZeroDash wallets.
5. `npm run dev --workspace=services/achievement-service` and `services/reward-service` — both consume the same `GAME_SAVED` stream concurrently with `profile-service`. Confirmed: a `coinSnapshot >= 8` event correctly unlocks the `first_save` achievement and grants the `cross_game_warzone_shotgun` reward (the direct replacement for `warzoneGunRewardClient.js`).
6. **Known gap found and fixed during verification:** every consumer independently calling `prisma.user.upsert()` on the same wallet races under concurrent delivery and throws a Postgres unique-constraint error (`P2002`). Fixed once, centrally, via `getOrCreateUser` in `shared/utils/src/get-or-create-user.ts` (catches the conflict and re-reads instead of retrying the insert) — all four consumers (`profile-service`, `leaderboard-service`, `achievement-service`, `reward-service`) use it. If you add a fifth consumer that creates `User` rows, use this helper rather than a raw upsert.

**Note on Warzone:** the placeholder `WARZONE_BACKEND_URL` in `.env.example` (`https://warzone-backend-0g.onrender.com`) returned 404 when checked live — it was a guess, since the Warzone repo analysis didn't surface a confirmed deployed URL. Replace it with the real deployed Warzone backend URL before relying on `sync-service` syncing Warzone for anything beyond a code read.

## Round 2: managed save pipeline — also actually run, not just described

7. `npm run dev --workspace=services/save-service` — without `ZG_PRIVATE_KEY`/`ZG_RPC_URL` set, `GET /healthz` reports `storageMode: "local-disk"` (confirmed). **Note: as of Round 4, `save-service`'s own contract is schema-agnostic — `POST /save/<gameKey>` expects `{ data, coinSnapshot?, important? }`, not the raw save JSON directly.** Calling it directly like that is useful for isolating `save-service` itself, but the real integration path is through a per-game service (step 14 below); see `architecture/02-service-communication.md` flow 2b. Confirmed live either way: deleting the Redis key `cache:save:<gameKey>:<wallet>` directly and re-calling `GET /save/<gameKey>` still returns the exact original JSON, recovered from the local-disk storage driver standing in for 0G — proving the driver, not Redis, is the real source of truth.
8. `npm run dev --workspace=services/verification-service` — `GET /healthz` reports `computeConfigured: false` without `ZG_COMPUTE_API_KEY`. After a save via step 7, confirmed: it consumes the resulting `SAVE_COMPLETED` event, publishes `game.<gameKey>.save_validated` with `verdict: "SKIPPED"`, and merges `computeStatus: "skipped"` into the existing `UserGameProgress.metadata` without clobbering `coinSnapshot`/`encoding`/`storageMode`.
9. `npm run dev --workspace=services/achievement-service` and `services/reward-service` (rebuilt with the XP/battle-pass wiring) alongside `services/profile-service` — confirmed live: one `POST /save/zerodash` call for a fresh wallet correctly produced `achievementCount: 1`, `xpTotal: 50`, `level: 1` (via `GET /profile/:wallet`) **and** a platform-wide `BattlePassProgress` row with `xp: 50` (via `GET /battle-pass/:wallet` on reward-service) — the full mission/save → achievement → XP → battle pass chain, from one real HTTP call.

## Round 3: data-driven rules, SecurityAuditLog, and the adapter consolidation — also actually run

10. `npm run dev --workspace=services/game-adapters/sync-service` — `GET /healthz` returns `{"syncing": ["zerodash", "warzone"]}`, read live from the `Game` table, not from per-game env vars. Confirmed live: running `UPDATE games SET "integrationMode"='NATIVE_SDK' WHERE key='warzone'` in Postgres made `sync-service` drop `"warzone"` from `syncing` within one `SYNC_SERVICE_REFRESH_INTERVAL_MS` cycle, with no restart — reverting the row brought it back the same way. This is the literal proof that retiring a game's bridge is a database update, not a deploy.
11. `npm run dev --workspace=services/achievement-service` / `services/reward-service` (rebuilt with the generic `matchesEventCriteria` rule engine) — confirmed live: a synthetic `game.zerodash.game_saved` event with `coinSnapshot: 30` correctly granted `cross_game_warzone_shotgun`, evaluated entirely from the `Reward.criteria` JSON column, not a hardcoded threshold constant.
12. **Real bug found and fixed during this verification pass:** `ensureSeedRewards`'s `prisma.reward.upsert(... update: {})` never backfilled the new `criteria` column onto the `cross_game_warzone_shotgun` row that already existed from Round 2 — the row sat with `criteria: NULL` and the generic evaluator silently never matched it. Caught by testing the actual grant, not by reading the seed code. Fixed by making `update` re-apply `criteria`/`payload` on every startup (same fix applied to `achievement-service`'s seed for consistency, even though it wasn't actually broken there).
13. `npm run dev --workspace=services/identity-service` (rebuilt with `@platform/db` + `SecurityAuditLog` writes) — confirmed live: a successful login writes `LOGIN_SUCCESS` with a linked `userId`; replaying a spent nonce writes `NONCE_INVALID_OR_EXPIRED`; an invalid signature writes `SIGNATURE_VERIFICATION_FAILED` — both failure cases with `userId: null`, since no `User` row need exist for a failed attempt.

## Round 5: per-game services + synchronous TEE gate — also actually run

14. `npm run dev --workspace=services/games/warzone-service` and `services/games/zerodash-service` — **this is the real integration path**: Unity calls these, never `save-service` directly. `POST /save` (a real Warzone-shaped JSON body, `Authorization: Bearer <jwt>`) validates against `services/games/warzone-service/src/save-schema.ts`'s own schema, then forwards `{ data, coinSnapshot }` to `save-service` internally and relays the response; `GET /save` round-trips. Confirmed live: a malformed body (e.g. negative `PlayerResources.coin`) is rejected `400` by `warzone-service` itself and never reaches `save-service` at all.
15. `POST /mission-completed { missionId, kills, timeSeconds }` on `warzone-service`, `Authorization: Bearer <jwt>` — confirmed live: with no `ZG_COMPUTE_API_KEY` set, returns `201 { missionId, verdict: "SKIPPED" }` and publishes `game.warzone.mission_completed`. Within ~2s, `GET /profile/:wallet` on `profile-service` showed `achievementCount` incremented (warzone-service's own seeded `warzone_first_blood` achievement, scoped to `gameId: warzone`) and `xpTotal` up by 50 — the full chain from one HTTP call, with `achievement-service` and `reward-service` unaware Warzone or "missions" exist as concepts.
16. **A real bug found and fixed during this verification pass, the same general shape as Round 3's seed-upsert bug:** `profile-service`'s `GAME_SAVED` consumer did a blind metadata *replace* on `UserGameProgress`, racing with `verification-service`'s update and intermittently clobbering its verdict back to `"pending"`. Caught by running the full chain and checking Postgres directly, not by reading either consumer in isolation. Fixed by merging metadata instead of replacing it (`services/profile-service/src/game-saved.consumer.ts`) — re-ran the test after the fix and confirmed `computeStatus`/`verdict` survive correctly.
17. **A real lesson about npm workspaces, not specific to this codebase:** adding `services/games/warzone-service` and `services/games/zerodash-service` required adding `"services/games/*"` to the root `package.json`'s `workspaces` array — the existing `"services/*"` glob only matches one directory level deep, so npm silently ignored the new packages until that was added. If you add a new nested service directory in the future, check `npm ls --workspaces` picks it up before assuming a missing dependency error means something else is wrong.

## Adding a new platform service (Identity/Profile/Achievement-style — one level deep)

1. `mkdir services/<name> && cd services/<name>`
2. Copy `package.json`/`tsconfig.json`/`Dockerfile` from the most similar existing service (e.g. `achievement-service` if it's an event consumer, `leaderboard-service` if it also needs Redis + a REST read API) and rename.
3. This is covered by the root `package.json`'s `"services/*"` glob already — no change needed there.
4. Add it to `docker-compose.yml` and, if it should be reachable from outside the cluster, to `services/api-gateway/src/main.ts`'s `SERVICES` map.

## Adding a new game's per-game service (the recommended path for a new game — see `docs/migration-guide-new-games.md`)

1. `mkdir services/games/<yourgame>-service && cd services/games/<yourgame>-service`, copy the simpler reference (`services/games/zerodash-service`) or the one with a gameplay-event endpoint too (`services/games/warzone-service`).
2. **This directory is two levels deep under `services/` — the `"services/*"` glob does NOT match it.** It's covered by a separate `"services/games/*"` entry in the root `package.json`'s `workspaces` array, added specifically when this pattern was introduced. If you ever add a service nested any deeper than `services/<name>` or `services/<group>/<name>`, check whether the existing globs actually reach it (`npm ls --workspaces` shows what npm picked up) before assuming the build will just work.
3. Write `src/save-schema.ts` (a Zod schema for this game's real save shape) and `src/save.routes.ts` (validate, then forward `{ data, coinSnapshot }` to `save-service` internally, relay the response) — see either reference implementation.
4. Add `<YOURGAME>_SERVICE_PORT` and (if it talks to `save-service`, which it always should) `SAVE_SERVICE_URL` to `.env.example`, a service block to `docker-compose.yml`, and an entry to `services/api-gateway/src/main.ts`'s `GAME_SERVICES` map (routed under `/api/v1/play/<gameKey>`, distinct from the legacy `/api/v1/games/<gameKey>` passthrough).

## Coding conventions

- TypeScript everywhere in `services/` and `shared/`; the two existing game repos remain plain JS and are never touched.
- Use `@platform/utils`'s `createLogger` (pino) instead of `console.log` — this was an explicit anti-pattern flagged in both existing repos during the architecture analysis.
- Validate event payloads against the Zod schemas in `@platform/events` on both publish and consume.
- A service writes to the Postgres tables it "owns" per the comment block at the top of `shared/db/prisma/schema.prisma`; reading other tables is fine, writing isn't.
- **Never persist actual save content outside 0G Storage.** If you're tempted to add a column or table that mirrors a game's save JSON for query convenience, don't — extend `UserGameProgress.metadata` with one or two scalar fields instead (the `coinSnapshot` pattern), or query 0G Storage directly. This was an explicit correction during Round 2's design; see `architecture/03-database-diagram.md`.
