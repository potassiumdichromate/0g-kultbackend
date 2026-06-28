# Redis Strategy

See [00-platform-vision.md](./00-platform-vision.md) — Redis here is always a cache the platform owns, never a source of truth (that's 0G Storage for save content, Postgres for platform-computed records). Key namespace conventions are centralized in `shared/utils/src/redis-client.ts` (`RedisKeys`) so no service invents its own ad-hoc key format.

| Use case | Key pattern | Data structure | TTL | Notes |
|---|---|---|---|---|
| SIWE nonce | `auth:nonce:<wallet>` | String (JSON) | 300s | Replaces the Mongo `AuthNonce` TTL-indexed collection in both existing repos — same single-use, 5-minute guarantee, no extra DB |
| Session | `session:<wallet>` | String / Hash | configurable | Reserved for Phase 2 session revocation (today auth is stateless JWT; this key exists for when a blacklist/refresh-token model is added) |
| Cached profile | `cache:profile:<wallet>` | String (JSON) | 60s | profile-service can populate this to avoid a Postgres round-trip on every gateway-proxied profile read |
| Cached rootHash | `cache:roothash:<gameKey>:<wallet>` | String | none (overwritten) | Mirrors the latest `UserGameProgress.rootHash` for fast lookup without a DB hit |
| **Cached decoded save (Round 2)** | `cache:save:<gameKey>:<wallet>` | String (JSON) | none (overwritten) | `save-service`'s fast working copy — written immediately on `POST /save`, served on `GET /save` cache hits. **Not a source of truth**: flushing this key loses nothing, because every save is always recoverable from 0G Storage via the `rootHash` Postgres holds. Verified live by deleting this key mid-test and confirming `GET /save` still returned the exact original JSON, recovered from the storage driver — see `Knowledge_Base.md`. |
| Online players | `online:<gameKey>` | Set / Sorted set (score = last-heartbeat timestamp) | per-member expiry via periodic sweep | Future: populated by a presence heartbeat once games adopt the SDK |
| Leaderboard (hot path) | `leaderboard:<gameKey>:<metric>` | Sorted set (ZADD wallet -> score) | none | leaderboard-service writes on every relevant event; reads are `ZREVRANGE ... WITHSCORES` |
| Global leaderboard | `leaderboard:global:<metric>` | Sorted set | none | Cross-game aggregate (e.g. total XP) — not yet populated by the skeleton, reserved for when `xp_gained` events are wired into a global score |
| Matchmaking queue | `matchmaking:<gameKey>` | List / Stream | none | Reserved for future real-time games; no consumer in the skeleton |
| Adapter polling cursor | `adapter:<gameKey>:lastSeenSaveIndex:<wallet>` | String (int) | none | Internal to the polling adapters — not part of the public Redis contract, just how they avoid re-publishing the same save |

## Why Redis for leaderboards instead of querying Postgres directly

A `ZREVRANGE` on a sorted set is O(log N + M) and doesn't touch the database at all; with 100+ games each running their own leaderboard plus a global one, that's the difference between a few hundred microseconds and a `GROUP BY` aggregate query under load. Postgres (`LeaderboardSnapshot`) stays the durable source that can rebuild Redis after a flush or audit historical standings — Redis is never the only copy of anything that matters.

## Why nonces moved out of Mongo and into Redis, not Postgres

A nonce is purely ephemeral, single-use, 5-minute-lived state — exactly what Redis TTL keys are built for. Putting it in Postgres would mean either a cron-based cleanup job or relying on application code to delete expired rows (the failure mode both existing repos already avoid via Mongo's native TTL index). Redis's `EX` option gives the same guarantee with less code.
