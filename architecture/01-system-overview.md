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
                    (TRANSITIONAL — existing repos,   (THE TARGET — per-game
                     unmodified, until migrated)        service, see below)
                                      │                     │
                                      ▼                     ▼
                              ┌─────────────────────────────┐
                              │         API Gateway          │
                              │  auth guard · rate limit ·   │
                              │  /games (legacy passthrough) │
                              │  /play (platform per-game)   │
                              └───┬───────┬───────┬───────┬──┘
              ┌─────────────────────┘       │       │       └─────────────────┐
              ▼                             ▼       ▼                         ▼
   ┌─────────────────────┐    ┌──────────────────────────┐ ┌──────────────────┐  ┌───────────────────────────┐
   │   Identity Service    │    │  warzone-service /         │ │ Verification     │  │  zerodash-0g-backend (existing,│
   │ SIWE nonce + JWT       │    │  zerodash-service           │ │ Service           │  │  UNMODIFIED, transitional) —   │
   └─────────────────────┘    │  (Round 4) — owns THIS       │ │ 0G Compute TEE    │  │  still owns its own 0G          │
                               │  game's save schema +        │ │ anti-cheat,        │  │  Storage/Chain/DA/Compute       │
                               │  gameplay-event vocabulary    │ │ async by default,  │  │  flow and MongoDB until         │
                               │  (e.g. mission-completed);    │ │ sync gate for       │  │  migration                      │
                               │  Unity's actual front door     │ │ "important" events  │  └───────────────────────────┘
                               └──────────┬───────────────────┘ │ (mission complete,  │  ┌───────────────────────────┐
                                          ▼                     │ tournament/NFT       │  │  warzone-backend-0g (existing, │
                              ┌─────────────────────┐           │ rewards, leaderboard)│  │  UNMODIFIED, transitional)      │
                              │  Save Service          │         │ consumes             │  └───────────────────────────┘
                              │  JSON in/out;           │         │ SAVE_COMPLETED       │
                              │  Redis working copy;     │         └─────────┬──────────┘
                              │  0G Storage = truth       │                   │
                              │  (schema-agnostic — the    │                   │
                              │   per-game service above    │                   │
                              │   already validated it)      │                   │
                              └──────────┬───────────────────┘                   │
                                          ▼                                       │
                              ┌─────────────────────────┐◀──────────────────────┘
                              │  Profile / Leaderboard /  │
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
                                           │ NATS JetStream events (GAME_SAVED, SAVE_COMPLETED, MISSION_COMPLETED, ...)
                              ┌────────────┴─────────────┐
                              │  sync-service (BRIDGE,     │
                              │  not a permanent pattern)  │
                              │  one config-driven worker  │
                              │  for every POLLING_ADAPTER │
                              │  game (poll the games' own  │
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
| **Identity Service** | SIWE nonce issuance + signature verification + JWT minting, drop-in compatible with both repos' existing JWT claim shape | Redis nonces, `security_audit_log` | Platform-owned, permanent; RS256/true-SSO is the next step (Phase 4) |
| **warzone-service / zerodash-service** (`services/games/*`) | **Round 4 — Unity's actual front door for the managed pipeline.** Owns that game's save schema + gameplay-event vocabulary (e.g. Warzone's `mission-completed`); validates, then delegates the generic mechanic to Save Service and publishes generic NATS events | nothing directly — delegates to Save Service / NATS | Platform-owned (per-game logic, generic mechanics). Reference pattern every future game's service follows — see vision doc. |
| **Save Service** | **The platform's save pipeline — the target for every game, old and new.** Schema-agnostic (validation now happens upstream, in the per-game service): caches in Redis, encodes+compresses, uploads to 0G Storage (sole source of truth for save content), stores only the rootHash pointer. Also runs a synchronous TEE gate for requests a per-game service flags `important` | `user_game_progress` | Platform-owned, permanent. ZeroDash/Warzone haven't migrated onto it yet — see roadmap. |
| **Verification Service** | Anti-cheat/TEE validation for saves going through Save Service — one shared implementation instead of one per game. Async by default; skips re-checking anything Save Service already gated synchronously | updates `user_game_progress.metadata` only | Platform-owned, permanent. Each existing repo keeps its own separate anti-cheat for now (by design — not unified with this service, see roadmap). |
| **Profile Service** | Unified `User` + `UserGameProgress` (rootHash-as-metadata); consumes `GAME_SAVED` from either path above | `users`, `user_game_progress`, `game_sessions` | Platform-owned, permanent |
| **Leaderboard Service** | Redis sorted sets (hot path) + Postgres durable snapshots; consumes save/score events | `leaderboard_snapshots`, Redis `leaderboard:*` | Platform-owned, permanent |
| **Achievement Service** | Evaluates declarative `criteria` (data, not code — see vision doc) against every `game.*.*` event, emits `ACHIEVEMENT_UNLOCKED` | `achievements`, `user_achievements` | Platform-owned, permanent |
| **Reward Service** | Grants rewards (including cross-game unlocks) in reaction to events — replaces the `warzoneGunRewardClient.js` hack | `rewards`, `user_rewards` | Platform-owned, permanent |
| **Analytics Service** | Durable raw-event sink for every `game.*` / `platform.*` message | `raw_events` | Platform-owned, permanent — the model other services should resemble |
| **Notification Service** | Fans out unlock/reward events to push/email/in-app (stubbed to structured logs today) | nothing persistent yet | Platform-owned, needs a real delivery channel built |
| **Game Adapters** (`services/game-adapters/sync-service`) | **Compatibility bridge, not a platform capability.** One service reads every `POLLING_ADAPTER` game from Postgres and polls each one's existing public endpoints, publishing `GAME_SAVED` so the rest of the platform doesn't need to know the game hasn't migrated yet | nothing — stateless except a Redis "last seen saveIndex" cursor | Transitional. Retires per-game the moment that game's `integrationMode` changes — verified live, no redeploy needed. (Round 1/2 shipped this as two standalone per-game services; Round 3 collapsed them into one config-driven `sync-service`.) |
| **zerodash-0g-backend / warzone-backend-0g** | The actual games, today. Unmodified. Still own their MongoDB, their 0G Storage/Chain/DA/Compute integration, their own auth | their own DBs — never written to by the platform | Transitional — the committed plan is for both to migrate save/load onto Save Service (Unity-side change only, repo stays as-is) |

See [02-service-communication.md](./02-service-communication.md) for sequence diagrams, [04-event-flow.md](./04-event-flow.md) for the event catalogue, [09-security-model.md](./09-security-model.md) for the managed pipeline's security guarantees, [08-migration-roadmap.md](./08-migration-roadmap.md) for the committed migration path, and [../docs/game/warzonewarriors.md](../docs/game/warzonewarriors.md) / [../docs/game/zerodash.md](../docs/game/zerodash.md) for a deep, per-game integration guide to each of the two existing backends listed in the table above.
