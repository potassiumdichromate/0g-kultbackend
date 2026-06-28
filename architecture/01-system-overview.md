# System Overview

## What this is

A platform that sits *alongside* the existing ZeroDash and Warzone Warriors backends — never inside them — and gives every game on it: one login, one wallet identity, a unified profile, shared XP, cross-game achievements, cross-game rewards, and a unified leaderboard, without either existing backend changing a single line of code today.

**Round 2 addition:** a *managed save pipeline* (`save-service` + `verification-service`) for games built directly on the platform — Unity sends/receives plain JSON; the backend owns encoding, compression, 0G Storage upload/download, and anti-cheat. This runs alongside the zero-touch path below, not instead of it; see [08-migration-roadmap.md](./08-migration-roadmap.md) for when a game would use one path vs. the other.

```
                              ┌─────────────────────────────┐
                              │        Unity WebGL games     │
                              │  ZeroDash · Warzone · future  │
                              └───────┬─────────────────┬─────┘
                          legacy binary save/load    JSON-only save/load
                          (unchanged, own backend)   (Round 2, managed pipeline)
                                      │                     │
                                      ▼                     ▼
                              ┌─────────────────────────────┐
                              │         API Gateway          │
                              │  auth guard · rate limit ·   │
                              │  reverse proxy               │
                              └───┬───────┬───────┬───────┬──┘
              ┌─────────────────────┘       │       │       └─────────────────┐
              ▼                             ▼       ▼                         ▼
   ┌─────────────────────┐    ┌──────────────────┐ ┌──────────────────┐  ┌───────────────────────────┐
   │   Identity Service    │    │  Save Service      │ │ Verification     │  │  zerodash-0g-backend (existing,│
   │ SIWE nonce + JWT       │    │  JSON in/out;       │ │ Service           │  │  UNMODIFIED) — owns its own     │
   └─────────────────────┘    │  Redis working copy; │ │ 0G Compute TEE    │  │  0G Storage/Chain/DA/Compute     │
                               │  0G Storage = truth   │ │ anti-cheat,        │  │  flow and MongoDB                │
                               └──────────┬───────────┘ │ consumes           │  └───────────────────────────┘
                                          │              │ SAVE_COMPLETED     │  ┌───────────────────────────┐
                                          ▼              └─────────┬──────────┘  │  warzone-backend-0g (existing, │
                              ┌─────────────────────────┐          │             │  UNMODIFIED) — same shape       │
                              │  Profile / Leaderboard /  │◀────────┘             └───────────────────────────┘
                              │  Achievement / Reward /   │
                              │  Analytics / Notification │
                              └────────────┬─────────────┘
                                           │ reads/writes
                                           ▼
                              ┌─────────────────────────┐
                              │   PostgreSQL (Prisma)    │   pointers + platform-computed records only —
                              │   + Redis (hot cache)     │   NEVER the actual save content (0G Storage is
                              └─────────────────────────┘   the sole source of truth for that, always
                                           ▲                 binary-encoded — see 03-database-diagram.md)
                                           │ NATS JetStream events (GAME_SAVED, SAVE_COMPLETED, ...)
                              ┌────────────┴─────────────┐
                              │  Game Adapters             │
                              │  zerodash-adapter ·         │
                              │  warzone-adapter            │
                              │  (poll the games' own        │
                              │   public REST endpoints —    │
                              │   read-only, zero-touch)     │
                              └───────────────────────────┘
```

## Why a platform layer instead of a rewrite

Both existing backends already do the hard part correctly: Unity → binary save → 0G Storage → RootHash → Mongo metadata → on load, RootHash → 0G Storage → binary → Unity. That flow is proven and must not move. What's missing is everything *above* a single game: one identity across games, one place to compute cross-game XP, one place to evaluate "you played 3 games this week" achievements. Those are platform concerns, not game concerns, and bolting them onto either existing repo would re-create exactly the coupling already visible in ZeroDash's `crossGameService.js` / `warzoneGunRewardClient.js` hack (hardcoded URLs, a shared secret, one game's code knowing about another game's existence).

## Service responsibilities

| Service | Responsibility | Owns (writes) |
|---|---|---|
| **API Gateway** | Single ingress: JWT auth guard, rate limiting, reverse proxy to platform services and (pass-through only) to the real game backends | nothing — stateless |
| **Identity Service** | SIWE nonce issuance + signature verification + JWT minting, drop-in compatible with both repos' existing JWT claim shape | Redis nonces |
| **Profile Service** | Unified `User` + `UserGameProgress` (rootHash-as-metadata); consumes `GAME_SAVED` | `users`, `user_game_progress`, `game_sessions` |
| **Leaderboard Service** | Redis sorted sets (hot path) + Postgres durable snapshots; consumes save/score events | `leaderboard_snapshots`, Redis `leaderboard:*` |
| **Achievement Service** | Evaluates declarative criteria against the event stream, emits `ACHIEVEMENT_UNLOCKED` | `achievements`, `user_achievements` |
| **Reward Service** | Grants rewards (including cross-game unlocks) in reaction to events — replaces the `warzoneGunRewardClient.js` hack | `rewards`, `user_rewards` |
| **Analytics Service** | Durable raw-event sink for every `game.*` / `platform.*` message | `raw_events` |
| **Notification Service** | Fans out unlock/reward events to push/email/in-app (stubbed to structured logs today) | nothing persistent yet |
| **Game Adapters** (`zerodash-adapter`, `warzone-adapter`) | Phase-1, zero-touch bridge: poll each game's existing public endpoints, publish `GAME_SAVED` | nothing — stateless except a Redis "last seen saveIndex" cursor |
| **Save Service** *(Round 2)* | JSON-only save/load for the managed pipeline. 0G Storage is the sole source of truth for save content (binary-encoded); Redis is a fast working copy; Postgres holds only the `rootHash` pointer | `user_game_progress` (managed-pipeline rows) |
| **Verification Service** *(Round 2)* | Anti-cheat/TEE validation for managed saves — ports `ZeroGCompute.js`'s anti-cheat client (duplicated in both existing repos) into one shared implementation, consumes `SAVE_COMPLETED`, publishes `SAVE_VALIDATED` | updates `user_game_progress.metadata` only |
| **zerodash-0g-backend / warzone-backend-0g** | The actual games. Unmodified. Still own their MongoDB, their 0G Storage/Chain/DA/Compute integration, their own auth | their own DBs — never written to by the platform |

See [02-service-communication.md](./02-service-communication.md) for sequence diagrams, [04-event-flow.md](./04-event-flow.md) for the event catalogue, [09-security-model.md](./09-security-model.md) for the managed pipeline's security guarantees, [08-migration-roadmap.md](./08-migration-roadmap.md) for how this gets rolled out without risk, and [../docs/game/warzonewarriors.md](../docs/game/warzonewarriors.md) / [../docs/game/zerodash.md](../docs/game/zerodash.md) for a deep, per-game integration guide to each of the two existing backends listed in the table above.
