# 0g-kultbrowser

A platform that sits *next to* existing games (ZeroDash, Warzone Warriors, and future ones) and stitches them into one ecosystem — one login, one profile, shared XP, cross-game achievements and rewards, one leaderboard — **without changing anything inside those games.**

This doc is the simple version. For the full detail, see the links at the bottom.

## The one idea that explains everything else

> **Each game keeps doing its own thing. This platform just watches, and connects the dots.**

ZeroDash and Warzone Warriors are two separate, already-working backends. They each handle their own players' saves, wallets, and 0G Storage uploads — that part is untouched and stays untouched. This project is the *new* layer on top that makes them feel like one ecosystem instead of two unrelated apps.

## How a save actually travels today (the part that already works)

```
Player plays Warzone/ZeroDash
        │
        ▼
Game's OWN backend (unchanged) — handles save/load, wallet login, 0G upload, exactly as before
        │
        │  every ~15 seconds, a small "adapter" politely asks:
        │  "hey, did anyone's save change?" (using an endpoint the game already has)
        ▼
Game Adapter  →  announces "wallet X just saved!" on an internal message bus (NATS)
        │
        ├──► Profile Service     — updates that player's unified profile
        ├──► Leaderboard Service — updates rankings
        ├──► Achievement Service — checks if they unlocked something
        ├──► Reward Service      — checks if they earned a cross-game reward
        └──► Analytics Service   — logs it
```

The key thing: **none of those five services know the game exists.** They just listen for "something happened" announcements. That's also why adding game #3, #4, or #100 doesn't mean touching any existing service — it's just one more adapter announcing on the same bus.

## How a save works for a *brand-new* game (optional, not used by ZeroDash/Warzone yet)

If a new game doesn't want to build its own save backend at all, it can use ours instead:

```
Unity sends plain JSON (just the save data — no encoding, no 0G calls)
        │
        ▼
Save Service
        ├─ 1. remembers it in Redis immediately (fast — so reloading is instant)
        ├─ 2. encodes + uploads it to 0G Storage  ← this is the REAL, permanent save
        └─ 3. tells our database only: "here's a receipt" (a pointer/hash)
```

**Important:** our database never stores the actual save content — coins, inventory, progress, none of it. It only ever stores a pointer to where the real save lives on 0G Storage. If you wiped Redis and the database tomorrow, every save would still be fully recoverable from 0G. We actually tested this (delete the cache, reload — works).

A separate **Verification Service** quietly checks saves for cheating in the background (and does nothing if no anti-cheat API key is configured — it just skips, rather than failing).

## The pieces, in plain English

| Piece | What it does |
|---|---|
| **API Gateway** | The front door. Routes a request to whichever service should handle it. |
| **Identity Service** | Wallet login: sign a message, get back a login token. |
| **Profile Service** | "Who is this player, across every game?" |
| **Leaderboard Service** | Rankings — per game and global. |
| **Achievement Service** | "Did they just unlock something?" |
| **Reward Service** | "Do they deserve a reward — maybe usable in a *different* game?" |
| **Analytics Service** | Logs everything that happens, for stats later. |
| **Notification Service** | Where push/email notifications would plug in (not built out yet). |
| **Save Service + Verification Service** | The optional "we handle your save for you" pipeline described above. |
| **Game Adapters** | The "polite watchers" — one per existing game, checking for changes. |

## The boring infrastructure underneath

- **PostgreSQL** — the database. Only ever stores pointers and small facts (like "this wallet has 50 XP"), never actual save files.
- **Redis** — fast, temporary memory. A cache so we don't hit the database or 0G on every single read.
- **NATS** — the "announcement board" every service posts to and listens from, without knowing who else is listening.
- **0G Storage** — the real, permanent home for every save file, always encoded.

## Why it's built this way

- **Zero risk to existing games**: nothing here can break ZeroDash or Warzone Warriors, because nothing here is allowed to modify them — it only ever reads their already-public data.
- **Adding game #100 should be cheap**: a new game is one more "adapter" or one config row, not a code change in every other service.
- **One source of truth per kind of data**: save content always lives on 0G, never duplicated into our database. Achievements/rewards/XP are *our* data (the platform computed them), so those do live in our database.

## Where to go for more detail

- [`architecture/01-system-overview.md`](./architecture/01-system-overview.md) — the full system diagram
- [`docs/architecture-explanation.md`](./docs/architecture-explanation.md) — *why* each decision was made
- [`docs/game/warzonewarriors.md`](./docs/game/warzonewarriors.md) / [`docs/game/zerodash.md`](./docs/game/zerodash.md) — exactly how each existing game works today
- [`docs/development-guide.md`](./docs/development-guide.md) — how to run this locally
- [`docs/migration-guide-new-games.md`](./docs/migration-guide-new-games.md) — how a new game plugs in
- [`Knowledge_Base.md`](./Knowledge_Base.md) — the full history of decisions made on this project, in order
