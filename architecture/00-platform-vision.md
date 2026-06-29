# Platform Vision — Read This First

Every other document in `architecture/` and `docs/` assumes the mindset on this page. If a design decision elsewhere seems to contradict it, that's a bug in this codebase's documentation, not an exception to the rule.

## The one sentence that governs everything else

**We are not building better game backends. We are building a gaming platform that games plug into — like Steam, Xbox Live, or Epic Online Services. The platform owns almost everything except gameplay itself.**

A game's job shrinks to four things:

- Gameplay
- Rendering
- Input
- Local game logic (the in-memory rules of *that specific game*)

Everything else — identity, profiles, wallet integration, the entire save lifecycle, security/validation, encoding/compression, 0G Storage, Postgres metadata, Redis caching, cross-game progression, achievements, rewards, battle pass, analytics, notifications, and (later) social/inventory/marketplace — is a **platform capability**. A game doesn't build its own version of these. It plugs into the platform's version.

## Why this isn't aspirational fluff — it's the literal lesson from the two games we already analyzed

ZeroDash and Warzone Warriors were each built as if they were the only game that would ever exist. The result, found by reading both repos line for line:

- Both reimplemented SIWE nonce + JWT auth — nearly identical code, twice.
- Both reimplemented the 0G Storage upload/download client — nearly identical code, twice.
- Both reimplemented the 0G Chain anchor call and the 0G DA dispersal client — nearly identical code, twice.
- Both reimplemented 0G Compute anti-cheat calling — nearly identical code, twice.
- ZeroDash went further and hardcoded a *direct HTTP call to Warzone's API*, including a literal shared-secret string committed to source, just to grant one cross-game reward.

That last one is the tell. When games don't have a platform to plug into, they start building ad-hoc bridges directly to each other — which is exactly the kind of N² coupling a platform exists to prevent. Every duplicated file above is the cost of "game-centric" design, paid twice already with only two games. At 100 games it's paid 100 times.

## What the platform owns (target state)

| Capability | Owned by | Why a game shouldn't build its own |
|---|---|---|
| Identity (wallet login, sessions) | `identity-service` | One login should work everywhere; a game building its own SIWE flow is the ZeroDash/Warzone duplication happening again |
| Unified profile, XP, level | `profile-service` | "One profile" is incoherent if each game keeps its own |
| Save lifecycle: validation → (optional TEE verification) → encode → compress → upload to 0G → store rootHash → cache | `save-service` + `verification-service`, fronted by that game's own per-game service (below) | This is 0G-specific, security-sensitive infrastructure code — the exact code that was already duplicated twice; a game should never write it a third time |
| Security/anti-tamper for the save path | `save-service` (sync structural) + `verification-service` (async semantic/anti-cheat, or synchronous for important events) | Wallet-from-JWT-never-body, server-computed saveIndex, schema validation — see `architecture/09-security-model.md` |
| Cross-game progression, achievements, rewards, battle pass | `achievement-service`, `reward-service`, `profile-service` | These only mean anything if they're computed centrally, from every game's events, not per-game |
| Analytics | `analytics-service` | One place to ask "what's happening across the whole platform," not N places |
| Notifications | `notification-service` | One inbox/channel, not N separate ones |
| Leaderboards (per-game and global) | `leaderboard-service` | A "unified leaderboard" requires one ranking authority |
| Future: friends, inventory, marketplace | not yet built | Same principle applies — these become platform capabilities, not per-game features, when they're built |

## The per-game service: the one piece of the platform that *is* game-specific, by design

Round 4 added `services/games/<game>-service` (`warzone-service`, `zerodash-service`) as the layer Unity actually talks to — not `save-service` directly. This isn't a contradiction of "games are plugins": a per-game service owns exactly two things that are inherently that game's own concern, and nothing else —

1. **That game's save shape** (a Zod schema — `services/games/warzone-service/src/save-schema.ts`, moved out of a shared file in this round specifically so adding game #101 never means editing shared code) and the validation against it, before anything is forwarded to the generic, schema-agnostic `save-service`.
2. **That game's gameplay-event vocabulary** (Warzone's `mission-completed{missionId, kills, timeSeconds}`) — translated into the platform's generic NATS event schema (`MissionCompletedPayloadSchema`) so every downstream consumer (achievement/reward/leaderboard/analytics/profile) reacts without ever knowing Warzone-specific field names exist.

Everything else a per-game service does is delegation: it calls into `save-service` for the actual encode/upload/cache mechanic, and publishes to NATS for everything else. A per-game service should never itself talk to 0G Storage, Postgres, or implement anti-cheat from scratch — the moment it does, that's the duplication this whole architecture exists to prevent, just one layer further down. See `docs/architecture-explanation.md` for the worked example (Warzone's `MISSION_COMPLETED` → achievement/reward/profile fan-out, live-verified).

A game contributes exactly one thing the platform doesn't have: **what its save data looks like** (a JSON schema) and **what its gameplay events mean** (mission IDs, level numbers). Everything that moves those bytes, secures them, stores them, and turns them into cross-game value is the platform's job.

## The North Star for progression: move from "client states its balance" to "platform computes its balance"

Today, a save is a full snapshot the client reports (`{coins: 1500, ...}`), and the platform validates its *shape* and *asynchronously* flags implausible deltas after the fact. That is **client-as-source-of-truth with a fraud detector watching it** — workable, but not the target.

The target: the client increasingly reports *what happened* (gameplay events — coins collected, an enemy defeated, a mission completed), and the platform computes and stores the resulting state itself, validating each step as it's applied rather than trusting a final number after the fact. Concretely, that means economically-meaningful numbers (currency, XP, things that cross into rewards/leaderboards/battle-pass) move toward being platform-computed ledgers fed by events, while purely cosmetic/local save state (character position, UI preferences, which menu was open) can remain a client-reported snapshot indefinitely — that part genuinely doesn't need a source-of-truth fight.

**This is a north star, not a refactor done today.** It changes how new capability should be designed going forward (event-shaped, not snapshot-shaped, wherever the data feeds cross-game value) without requiring an event-sourcing rewrite of what already exists. See `architecture/09-security-model.md` for exactly where today's implementation sits on this spectrum, table by table.

## Inventory: where today's design is still game-centric, and what that implies

This is the literal answer to "identify every place the design is still game-centric instead of platform-centric." Each entry is judged against the one-sentence rule above.

| Where | Game-centric today | Platform-centric target | Status |
|---|---|---|---|
| **Game Adapters** (was `zerodash-adapter`/`warzone-adapter`, two services) | ~~One bespoke service per game, hardcoded to that game's specific public endpoint shapes~~ | A single generic, config-driven sync worker (or: nothing at all, once a game migrates to `save-service`) | **Done (Round 3).** Collapsed into one `services/game-adapters/sync-service` that reads which games to poll from the `Game` table. Verified live: flipping a `Game.integrationMode` row makes it start/stop polling that game within one refresh cycle, no redeploy — the literal "config, not code" property this row used to lack. |
| **Each existing repo's own 0G Storage/Chain/DA/Compute clients** | Duplicated nearly verbatim across two repos (the proof above) | `shared/zg-client` + `save-service` + `verification-service`, written once | Already built and live-verified for the managed pipeline. ZeroDash/Warzone haven't migrated onto it yet — that's the committed Phase 3 target, not an optional side door (see roadmap). |
| **Auth secret alignment** | Each game repo independently configures and verifies its own JWT secret; "single login" today only works if those secrets are manually pointed at the same value | RS256: games trust the platform's public key, never mint or verify a token themselves | Phase 4 in the roadmap. Re-prioritized here as core to the vision, not late-stage polish — "one identity" isn't fully true until this lands. |
| **Achievement/Reward criteria** | ~~One hardcoded rule each (`first_save`, a ZeroDash-coins-to-Warzone-item threshold), written as TypeScript, not data~~ | Criteria stored as data (the `Achievement.criteria` / `Reward.criteria` Json fields) and evaluated by one generic rule matcher | **Done (Round 3).** `shared/utils/src/criteria.ts`'s `matchesEventCriteria` is the one evaluator both `achievement-service` and `reward-service` run against every Achievement/Reward row. Caught a real bug doing this: a Round-2-seeded `Reward` row had never been backfilled with the new `criteria` value, silently breaking the rule until the seed's `upsert` was fixed to re-apply it on every startup. |
| **Per-game save schema registration** | ~~`ZeroDashSaveDataSchema`/`WarzoneSaveDataSchema` lived in a static code map in `shared/dto`~~ — **fixed in Round 4**: each schema moved into that game's own `services/games/<game>-service`, owned and deployed independently | Adding game #101 is a new per-game service, never an edit to shared code | Resolved. Still not a fully self-service *admin UI* (someone still writes the Zod schema in code), but the architectural coupling to shared code is gone. |
| **Save content validation depth** | Structural only (shape, ranges); the actual coin/XP *value* is trusted from the client, checked asynchronously after the save already succeeded | Server-computed/validated progression for economically-meaningful fields (see "North Star" above) | Explicitly a future direction, not a gap to panic about today — see `architecture/09-security-model.md`. |
| **The Browser / catalog / continue-playing / recently-played** | Doesn't exist as a frontend (confirmed out of scope for this repo) — but the backend data those features need is scattered/incomplete (`Game` has no display metadata; "continue playing" would need a clean query, not a new table) | Backend should be *ready* to serve these even though no UI is built here | Not urgent, but worth schema-planning ahead of time rather than retrofitting later — see the roadmap's forward-looking notes. |
| **Identity/Profile service scope** | Already correctly owned by the platform, but narrow (Identity = nonce+JWT only; Profile = wallet+XP+pointers only — no friends, inventory, sessions-with-revocation yet) | Same services, wider scope, as those systems get built | This is the *right* architecture already — it just needs to grow into the larger vision over time, not be redesigned. |
| **Leaderboard/Analytics/Notification services** | — | Already the model to replicate: consume wildcard event subjects, zero game-specific code, work identically for game #1 or #100 | These are the examples of "doing it right" already in the codebase. |

## What this means for "don't rewrite everything"

Most of the inventory above is a **framing and roadmap-priority change**, not a code change: Game Adapters were always meant to be temporary, but the docs described Phase 3 as optional/speculative when it should have been described as the committed destination. That's fixed by rewriting the roadmap's language, not the adapter code.

The two places where actual code changes are implied (rule criteria as data, self-service schema registration) are called out explicitly above as **follow-ups**, not done in this pass — consistent with reviewing the architecture before building further, which is what this document is for.
