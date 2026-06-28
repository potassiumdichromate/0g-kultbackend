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
npm run dev --workspace=services/game-adapters/zerodash-adapter
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
3. `npm run dev --workspace=services/game-adapters/zerodash-adapter` — within `ADAPTER_POLL_INTERVAL_MS` it polls the **real, live, public** ZeroDash backend (`https://zerog-zerodash.onrender.com`) and republishes each active player's latest save as a `GAME_SAVED` event with their real `rootHash`. Confirmed: 18 real players' saves were picked up in the first poll cycle. This only ever does read-only GETs against ZeroDash's already-public endpoints — nothing is written there.
4. `npm run dev --workspace=services/profile-service` — `GET http://localhost:3002/profile/<wallet>` returns the unified profile with that game's real `rootHash`/`saveIndex`/`coinSnapshot` mirrored into `UserGameProgress`. Confirmed against real ZeroDash wallets.
5. `npm run dev --workspace=services/achievement-service` and `services/reward-service` — both consume the same `GAME_SAVED` stream concurrently with `profile-service`. Confirmed: a `coinSnapshot >= 8` event correctly unlocks the `first_save` achievement and grants the `cross_game_warzone_shotgun` reward (the direct replacement for `warzoneGunRewardClient.js`).
6. **Known gap found and fixed during verification:** every consumer independently calling `prisma.user.upsert()` on the same wallet races under concurrent delivery and throws a Postgres unique-constraint error (`P2002`). Fixed once, centrally, via `getOrCreateUser` in `shared/utils/src/get-or-create-user.ts` (catches the conflict and re-reads instead of retrying the insert) — all four consumers (`profile-service`, `leaderboard-service`, `achievement-service`, `reward-service`) use it. If you add a fifth consumer that creates `User` rows, use this helper rather than a raw upsert.

**Note on Warzone:** the placeholder `WARZONE_BACKEND_URL` in `.env.example` (`https://warzone-backend-0g.onrender.com`) returned 404 when checked live — it was a guess, since the Warzone repo analysis didn't surface a confirmed deployed URL. Replace it with the real deployed Warzone backend URL before relying on `warzone-adapter` for anything beyond a code read.

## Round 2: managed save pipeline — also actually run, not just described

7. `npm run dev --workspace=services/save-service` — without `ZG_PRIVATE_KEY`/`ZG_RPC_URL` set, `GET /healthz` reports `storageMode: "local-disk"` (confirmed). `POST /save/zerodash` with a JSON body matching `ZeroDashSaveDataSchema` and `Authorization: Bearer <jwt>` (from step 2) returns `{ rootHash, saveIndex }`; `GET /save/zerodash` returns the exact same JSON back. Confirmed live: deleting the Redis key `cache:save:zerodash:<wallet>` directly and re-calling `GET /save/zerodash` still returned the exact original JSON, recovered from the local-disk storage driver standing in for 0G — proving the driver, not Redis, is the real source of truth. A tampered payload (negative numbers, missing required fields) was confirmed rejected with `400` and detailed Zod issues before anything was encoded.
8. `npm run dev --workspace=services/verification-service` — `GET /healthz` reports `computeConfigured: false` without `ZG_COMPUTE_API_KEY`. After a save via step 7, confirmed: it consumes the resulting `SAVE_COMPLETED` event, publishes `game.<gameKey>.save_validated` with `verdict: "SKIPPED"`, and merges `computeStatus: "skipped"` into the existing `UserGameProgress.metadata` without clobbering `coinSnapshot`/`encoding`/`storageMode`.
9. `npm run dev --workspace=services/achievement-service` and `services/reward-service` (rebuilt with the XP/battle-pass wiring) alongside `services/profile-service` — confirmed live: one `POST /save/zerodash` call for a fresh wallet correctly produced `achievementCount: 1`, `xpTotal: 50`, `level: 1` (via `GET /profile/:wallet`) **and** a platform-wide `BattlePassProgress` row with `xp: 50` (via `GET /battle-pass/:wallet` on reward-service) — the full mission/save → achievement → XP → battle pass chain, from one real HTTP call.

## Adding a new service

1. `mkdir services/<name> && cd services/<name>`
2. Copy `package.json`/`tsconfig.json`/`Dockerfile` from the most similar existing service (e.g. `achievement-service` if it's an event consumer, `leaderboard-service` if it also needs Redis + a REST read API) and rename.
3. Add it to the root `package.json` `workspaces` glob if it falls outside the existing `services/*` / `shared/*` patterns (it generally won't need to — both already match).
4. Add it to `docker-compose.yml` and, if it should be reachable from outside the cluster, to `services/api-gateway/src/main.ts`'s `SERVICES` map.

## Coding conventions

- TypeScript everywhere in `services/` and `shared/`; the two existing game repos remain plain JS and are never touched.
- Use `@platform/utils`'s `createLogger` (pino) instead of `console.log` — this was an explicit anti-pattern flagged in both existing repos during the architecture analysis.
- Validate event payloads against the Zod schemas in `@platform/events` on both publish and consume.
- A service writes to the Postgres tables it "owns" per the comment block at the top of `shared/db/prisma/schema.prisma`; reading other tables is fine, writing isn't.
- **Never persist actual save content outside 0G Storage.** If you're tempted to add a column or table that mirrors a game's save JSON for query convenience, don't — extend `UserGameProgress.metadata` with one or two scalar fields instead (the `coinSnapshot` pattern), or query 0G Storage directly. This was an explicit correction during Round 2's design; see `architecture/03-database-diagram.md`.
