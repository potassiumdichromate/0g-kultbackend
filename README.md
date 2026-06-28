# 0g-kultbrowser

A gaming **platform** — like Steam, Xbox Live, or Epic Online Services — that games plug into. The platform owns identity, profiles, wallets, the entire save pipeline, security, cross-game progression, achievements, rewards, battle pass, analytics, and notifications. A game owns gameplay, rendering, input, and local game logic. Nothing else.

ZeroDash and Warzone Warriors are the first two games. Neither has been modified to build this — but the long-term plan is for both (and every game after them) to fully plug into the platform rather than keep their own copies of infrastructure the platform now owns. See [`architecture/00-platform-vision.md`](./architecture/00-platform-vision.md) for the full reasoning; this doc is the simple version.

## The one idea that explains everything else

> **Games are plugins. The platform owns almost everything except gameplay.**

Today, ZeroDash and Warzone Warriors each built their *own* copy of: wallet login, 0G Storage upload/download, on-chain anchoring, anti-cheat. Nearly identical code, written twice, because neither had a platform to plug into. That's the exact problem this project exists to fix — not just for these two games, but for the 3rd, 10th, and 100th.

## How this plays out for the two games that exist today (transitional)

Because we don't modify either existing repo, the platform currently *watches* them rather than owning their save pipeline outright — a temporary bridge until they migrate (see the roadmap):

```
Player plays Warzone/ZeroDash
        │
        ▼
Game's OWN backend (unchanged, for now) — still does save/load, wallet login, 0G upload itself
        │
        │  every ~15 seconds, a "Game Adapter" politely asks:
        │  "hey, did anyone's save change?" (using an endpoint the game already has)
        ▼
Game Adapter  →  announces "wallet X just saved!" on the platform's internal message bus (NATS)
        │
        ├──► Profile Service     — updates that player's unified profile
        ├──► Leaderboard Service — updates rankings
        ├──► Achievement Service — checks if they unlocked something
        ├──► Reward Service      — checks if they earned a cross-game reward
        └──► Analytics Service   — logs it
```

**Game Adapters are a compatibility shim, not the target architecture.** They exist only because we can't touch the existing repos directly. The moment a game migrates onto the platform's save pipeline (below), its adapter is retired — the platform gets real-time events instead of polling for them.

## How the platform's actual save pipeline works (the target for every game, old and new)

This is the destination — not just an option for hypothetical future games. Unity's job shrinks to "send JSON, receive JSON":

```
Unity sends plain JSON (just the save data — no encoding, no compression, no 0G calls, no rootHash management)
        │
        ▼
Save Service
        ├─ 1. validates it, remembers it in Redis immediately (fast — so reloading is instant)
        ├─ 2. encodes + compresses + uploads it to 0G Storage  ← this is the REAL, permanent save
        └─ 3. tells PostgreSQL only: "here's a receipt" (a pointer/hash) — never the actual save content
        │
        ▼
Verification Service (optional, async) — checks the save for cheating in the background,
        and does nothing if no anti-cheat key is configured (skips, never fails the save)
```

**PostgreSQL never stores actual save content** — coins, inventory, progress, none of it. It only ever stores a pointer to where the real save lives on 0G Storage. If you wiped Redis and the database tomorrow, every save would still be fully recoverable from 0G. We've actually tested this (deleted the cache, reloaded — it worked, recovered straight from storage).

The longer-term direction goes one step further: instead of the client just *stating* its coin balance, the platform increasingly computes and validates that balance itself from gameplay events the client reports — see `architecture/00-platform-vision.md`'s "North Star" section. That's a future direction, not built yet.

## The pieces, in plain English

| Piece | What it owns |
|---|---|
| **API Gateway** | The front door. Routes a request to whichever service should handle it. |
| **Identity Service** | Wallet login: sign a message, get back a login token — usable across every game. |
| **Profile Service** | "Who is this player, across every game?" — unified XP, level, save pointers. |
| **Leaderboard Service** | Rankings — per game and global. |
| **Achievement Service** | "Did they just unlock something?" — across any game's events. |
| **Reward Service** | "Do they deserve a reward — maybe usable in a *different* game?" |
| **Analytics Service** | Logs everything that happens, platform-wide, for stats later. |
| **Notification Service** | Where push/email/in-app notifications plug in (not built out yet). |
| **Save Service + Verification Service** | The full save lifecycle described above — this is the platform's, not any one game's. |
| **Game Adapters** | Transitional-only: the "polite watchers" bridging existing games until they migrate onto Save Service directly. |

## The boring infrastructure underneath

- **PostgreSQL** — the database. Only ever stores pointers and small platform-computed facts (like "this wallet has 50 XP"), never actual save files.
- **Redis** — fast, temporary memory. A cache so we don't hit the database or 0G on every single read.
- **NATS** — the platform's internal "announcement board" every service posts to and listens from, without knowing who else is listening.
- **0G Storage** — the real, permanent home for every save file, always encoded. The single source of truth for save content.

## Why it's built this way

- **Games shouldn't reinvent platform infrastructure.** Identity, save pipelines, anti-cheat, and cross-game progression are the platform's job specifically *because* every game that builds its own version duplicates work and ends up wiring direct, brittle integrations to other games (exactly what we found already happening between ZeroDash and Warzone before this platform existed).
- **Zero risk to existing games today**: nothing here can break ZeroDash or Warzone Warriors right now, because nothing here is allowed to modify them — it only ever reads their already-public data, until they choose to migrate.
- **Adding game #100 should be cheap**: a new game should be a config row and a save-data schema, not a new service or a code change in every existing one.

## Where to go for more detail

- [`architecture/00-platform-vision.md`](./architecture/00-platform-vision.md) — **read this first** — the product vision and the game-centric-vs-platform-centric inventory
- [`architecture/01-system-overview.md`](./architecture/01-system-overview.md) — the full system diagram
- [`docs/architecture-explanation.md`](./docs/architecture-explanation.md) — *why* each decision was made
- [`docs/game/warzonewarriors.md`](./docs/game/warzonewarriors.md) / [`docs/game/zerodash.md`](./docs/game/zerodash.md) — exactly how each existing game works today, and its path onto the platform
- [`docs/development-guide.md`](./docs/development-guide.md) — how to run this locally
- [`docs/migration-guide-new-games.md`](./docs/migration-guide-new-games.md) — how a new game plugs in
- [`Knowledge_Base.md`](./Knowledge_Base.md) — the full history of decisions made on this project, in order
