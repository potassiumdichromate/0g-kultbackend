# System Overview

**Read [00-platform-vision.md](./00-platform-vision.md) first.** This page is the diagram and service-responsibility detail underneath that vision, not a separate one.

## What this is

A gaming **platform** that games plug into. The platform owns identity, unified profiles, the entire save pipeline (encoding, compression, 0G Storage, anti-cheat), cross-game progression, achievements, rewards, battle pass, analytics, and notifications. A game owns gameplay, rendering, input, and local logic — nothing else, by design.

ZeroDash and Warzone Warriors are the first two games on the platform. Neither has been modified to build any of this. But — and this is the important part — that's a transitional state, not the target architecture: the goal is for both to eventually plug fully into the platform's save pipeline below, retiring the polling bridge that exists only because their repos can't be touched directly today. See [08-migration-roadmap.md](./08-migration-roadmap.md) for the committed path.

```
                              ┌─────────────────────────────┐
                              │        Unity WebGL games     │
                              │  ZeroDash · Warzone · future  │
                              └───────┬─────────────────┬─────┘
                       legacy binary save/load      JSON-only save/load
                    (TRANSITIONAL — existing repos,   (THE TARGET — platform
                     unmodified, until migrated)        owns the full pipeline)
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
   │ SIWE nonce + JWT       │    │  JSON in/out;       │ │ Service           │  │  UNMODIFIED, transitional) —   │
   └─────────────────────┘    │  Redis working copy; │ │ 0G Compute TEE    │  │  still owns its own 0G          │
                               │  0G Storage = truth   │ │ anti-cheat,        │  │  Storage/Chain/DA/Compute       │
                               └──────────┬───────────┘ │ consumes           │  │  flow and MongoDB until         │
                                          │              │ SAVE_COMPLETED     │  │  migration                      │
                                          ▼              └─────────┬──────────┘  └───────────────────────────┘
                              ┌─────────────────────────┐          │             ┌───────────────────────────┐
                              │  Profile / Leaderboard /  │◀────────┘             │  warzone-backend-0g (existing, │
                              │  Achievement / Reward /   │                       │  UNMODIFIED, transitional)      │
                              │  Analytics / Notification │                       └───────────────────────────┘
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
                              │  Game Adapters  (BRIDGE,   │
                              │  not a permanent pattern)  │
                              │  zerodash-adapter ·         │
                              │  warzone-adapter            │
                              │  (poll the games' own        │
                              │   public REST endpoints —    │
                              │   read-only — retire on       │
                              │   migration to Save Service)  │
                              └───────────────────────────┘
```

## Why a platform layer, and why it's not optional infrastructure

ZeroDash and Warzone Warriors each independently built: SIWE auth, a 0G Storage client, a 0G Chain anchor call, a 0G DA dispersal client, and 0G Compute anti-cheat — nearly identical code, written twice, because there was no platform for either to plug into. ZeroDash went further and hardcoded a direct HTTP call into Warzone's API (with a literal shared secret committed to source) just to grant one cross-game reward. That's not a one-off mistake; it's what happens by default when games don't have somewhere to plug in: they wire ad-hoc bridges directly to each other.

The platform exists to be that "somewhere." Identity, the save pipeline, security/anti-cheat, and cross-game progression are platform capabilities precisely *because* every game that builds its own version repeats the duplication above. See [00-platform-vision.md](./00-platform-vision.md) for the full capability-ownership table and the inventory of where today's implementation still falls short of that target.

## Service responsibilities

| Service | Responsibility | Owns (writes) | Status |
|---|---|---|---|
| **API Gateway** | Single ingress: JWT auth guard, rate limiting, reverse proxy to platform services and (pass-through only) to the real game backends | nothing — stateless | Platform-owned, permanent |
| **Identity Service** | SIWE nonce issuance + signature verification + JWT minting, drop-in compatible with both repos' existing JWT claim shape | Redis nonces | Platform-owned, permanent; RS256/true-SSO is the next step (Phase 4) |
| **Save Service** | **The platform's save pipeline — the target for every game, old and new.** JSON in/out; validates, caches in Redis, encodes+compresses, uploads to 0G Storage (sole source of truth for save content), stores only the rootHash pointer | `user_game_progress` | Platform-owned, permanent. ZeroDash/Warzone haven't migrated onto it yet — see roadmap. |
| **Verification Service** | Anti-cheat/TEE validation for saves going through Save Service — one shared implementation instead of one per game | updates `user_game_progress.metadata` only | Platform-owned, permanent. Each existing repo keeps its own separate anti-cheat for now (by design — not unified with this service, see roadmap). |
| **Profile Service** | Unified `User` + `UserGameProgress` (rootHash-as-metadata); consumes `GAME_SAVED` from either path above | `users`, `user_game_progress`, `game_sessions` | Platform-owned, permanent |
| **Leaderboard Service** | Redis sorted sets (hot path) + Postgres durable snapshots; consumes save/score events | `leaderboard_snapshots`, Redis `leaderboard:*` | Platform-owned, permanent |
| **Achievement Service** | Evaluates criteria against the event stream, emits `ACHIEVEMENT_UNLOCKED` | `achievements`, `user_achievements` | Platform-owned; criteria are still code today, should become data — see vision doc |
| **Reward Service** | Grants rewards (including cross-game unlocks) in reaction to events — replaces the `warzoneGunRewardClient.js` hack | `rewards`, `user_rewards` | Platform-owned, permanent |
| **Analytics Service** | Durable raw-event sink for every `game.*` / `platform.*` message | `raw_events` | Platform-owned, permanent — the model other services should resemble |
| **Notification Service** | Fans out unlock/reward events to push/email/in-app (stubbed to structured logs today) | nothing persistent yet | Platform-owned, needs a real delivery channel built |
| **Game Adapters** (`zerodash-adapter`, `warzone-adapter`) | **Compatibility bridge, not a platform capability.** Poll each game's existing public endpoints, publish `GAME_SAVED` so the rest of the platform doesn't need to know the game hasn't migrated yet | nothing — stateless except a Redis "last seen saveIndex" cursor | Transitional. Retires per-game the moment that game migrates onto Save Service. |
| **zerodash-0g-backend / warzone-backend-0g** | The actual games, today. Unmodified. Still own their MongoDB, their 0G Storage/Chain/DA/Compute integration, their own auth | their own DBs — never written to by the platform | Transitional — the committed plan is for both to migrate save/load onto Save Service (Unity-side change only, repo stays as-is) |

See [02-service-communication.md](./02-service-communication.md) for sequence diagrams, [04-event-flow.md](./04-event-flow.md) for the event catalogue, [09-security-model.md](./09-security-model.md) for the managed pipeline's security guarantees, [08-migration-roadmap.md](./08-migration-roadmap.md) for the committed migration path, and [../docs/game/warzonewarriors.md](../docs/game/warzonewarriors.md) / [../docs/game/zerodash.md](../docs/game/zerodash.md) for a deep, per-game integration guide to each of the two existing backends listed in the table above.
