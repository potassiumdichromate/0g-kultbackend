# Service Communication

**Read [00-platform-vision.md](./00-platform-vision.md) first.** Flow 2 below is the *transitional* path ZeroDash/Warzone use today; flows 2b and 2c are the platform-owned pipeline that's the actual target for every game, including those two once migrated (see [08-migration-roadmap.md](./08-migration-roadmap.md)) — both are live-verified reference implementations (`warzone-service`/`zerodash-service`), not specified-but-unbuilt designs. All sequence diagrams are Mermaid — view in any Markdown renderer that supports it (GitHub, VS Code preview, etc.).

## 1. Login (single identity across every game)

```mermaid
sequenceDiagram
    participant Unity as Unity Client
    participant GW as API Gateway
    participant ID as Identity Service
    participant Redis

    Unity->>GW: GET /api/v1/auth/nonce?wallet=0x...
    GW->>ID: proxy
    ID->>Redis: SET auth:nonce:<wallet> {nonce, issuedAt} EX 300
    ID-->>Unity: { nonce, message, expiresIn: 300 }
    Unity->>Unity: sign message with wallet private key
    Unity->>GW: POST /api/v1/auth/login { wallet, signature, nonce }
    GW->>ID: proxy
    ID->>Redis: GET + DEL auth:nonce:<wallet> (single-use)
    ID->>ID: ethers.verifyMessage(message, signature)
    ID-->>Unity: { token (HS256 JWT), expiresIn: 7d }
    Note over Unity,ID: Claim shape {walletAddress, sub} is identical to what<br/>ZeroDash/Warzone's own auth middleware already expects —<br/>this token can be sent straight through to either game's<br/>existing /player/* routes once their JWT secret is aligned.
```

## 2. Save flow — TRANSITIONAL bridge (where ZeroDash/Warzone are today; not the target architecture)

```mermaid
sequenceDiagram
    participant Unity as Unity Client
    participant Game as zerodash-0g-backend (unmodified)
    participant ZG as 0G Storage/Chain/DA
    participant Adapter as sync-service
    participant NATS
    participant Profile as Profile Service
    participant PG as PostgreSQL

    Unity->>Game: POST /player/save/binary (unchanged)
    Game->>ZG: upload, anchor, disperse (unchanged)
    Game-->>Unity: { rootHash, saveIndex, txHash } (unchanged)

    loop every ADAPTER_POLL_INTERVAL_MS
        Adapter->>Game: GET /player/leaderboard/decentralized (public, existing)
        Adapter->>Adapter: diff saveIndex vs last-seen (Redis)
        alt saveIndex advanced
            Adapter->>Game: GET /player/save/metadata?wallet=0x... (public, existing)
            Adapter->>NATS: publish game.zerodash.game_saved
        end
    end

    NATS->>Profile: deliver game.zerodash.game_saved
    Profile->>PG: upsert UserGameProgress { rootHash, saveIndex, metadata }
    Note over Game,PG: The game's own save/load endpoints are the only path that ever<br/>touches the real save file. Postgres only ever holds the pointer.
```

## 2b. Save flow — THE TARGET (platform owns the entire pipeline; live-verified reference implementation, not yet used by either real game's Unity client)

**Round 4 changed this flow's shape**: Unity talks to that game's own per-game service (`warzone-service`/`zerodash-service`), never to `save-service` directly — and `save-service` itself no longer validates against any game's schema at all (that moved upstream). The gateway path is `/api/v1/play/<gameKey>`, deliberately distinct from `/api/v1/games/<gameKey>` (the legacy passthrough to the real, unmodified existing backend — see flow 2).

```mermaid
sequenceDiagram
    participant Unity as Unity Client
    participant GW as API Gateway
    participant Game as warzone-service / zerodash-service
    participant Save as Save Service
    participant Redis
    participant ZG as 0G Storage (or local-disk driver)
    participant PG as PostgreSQL
    participant NATS
    participant Verify as Verification Service

    Unity->>GW: POST /api/v1/play/<gameKey>/save { ...plain JSON, this game's real shape... } (Bearer JWT)
    GW->>Game: proxy
    Game->>Game: validate against THIS game's own Zod schema (services/games/<game>-service/src/save-schema.ts)
    Game->>Save: POST /save/<gameKey> { data: validatedPayload, coinSnapshot } (forwards Authorization header)
    Save->>Save: wallet from JWT, never body; saveIndex always server-computed
    Save->>NATS: publish game.<gameKey>.save_requested
    Save->>Redis: SET cache:save:<gameKey>:<wallet> (fast working copy — not the source of truth)
    Save->>Save: msgpack-encode, gzip-compress
    Save->>ZG: upload(buffer) -> rootHash
    Save->>PG: upsert UserGameProgress { rootHash, saveIndex, metadata } (pointer only, never the JSON)
    Save->>NATS: publish game.<gameKey>.save_completed AND game.<gameKey>.game_saved (same payload)
    Save-->>Game: { rootHash, saveIndex, computeStatus }
    Game-->>Unity: relay the same response

    NATS->>Verify: deliver save_completed
    Verify->>Verify: skip if computeStatus already set (synchronously gated, see flow 2c) — else: coinDelta/saveIndexDelta check (threshold from GameMetadata)
    Verify->>ZG: (if 0G Compute configured) anti-cheat call; else skip gracefully
    Verify->>PG: merge computeStatus/verdict into UserGameProgress.metadata (merge, never replace — see 09-security-model.md)
    Verify->>NATS: publish game.<gameKey>.save_validated

    Note over Unity,PG: Verified live: deleting the Redis key and re-loading still returns<br/>the exact original JSON, recovered from the storage driver — proof<br/>0G Storage, not Redis, is the real source of truth. Also verified live:<br/>a malformed payload is rejected by warzone-service's schema (400)<br/>before it ever reaches Save Service.
```

Load is the mirror: `GET /api/v1/play/<gameKey>/save` → per-game service → Save Service checks Redis first, falls back to Postgres → 0G Storage → decode → repopulate Redis on a cache miss.

## 2c. Gameplay event with a synchronous TEE gate — mission completion (live-verified)

For "important" events (mission completion, ranked results, tournament/NFT rewards, leaderboard submissions — see `09-security-model.md`), the per-game service can reject the request *before* anything is published, instead of only flagging it after the fact:

```mermaid
sequenceDiagram
    participant Unity as Unity Client
    participant GW as API Gateway
    participant Warzone as warzone-service
    participant Compute as 0G Compute (shared/zg-client)
    participant NATS

    Unity->>GW: POST /api/v1/play/warzone/mission-completed { missionId, kills, timeSeconds } (Bearer JWT)
    GW->>Warzone: proxy
    Warzone->>Warzone: validate body shape (Zod)
    Warzone->>Compute: runAntiCheat({ missionId, kills, timeSeconds, rootHash: reportToken }, MISSION_SYSTEM_PROMPT)
    alt no ZG_COMPUTE_API_KEY configured
        Compute-->>Warzone: { verdict: "SKIPPED" } — graceful, same pattern as everywhere else
    else configured and implausible (e.g. kill rate too high for elapsed time)
        Compute-->>Warzone: { verdict: "SUSPICIOUS", flags }
        Warzone-->>Unity: 422, mission report rejected — NOTHING published
    end
    Warzone->>NATS: publish game.warzone.mission_completed { metrics: {kills, timeSeconds}, teeVerified }
    Warzone-->>Unity: 201 { missionId, verdict }

    Note over NATS: From here it's the same generic fan-out as flow 3 below — Achievement/Reward/<br/>Analytics react to the event with zero Warzone-specific code. Live-verified:<br/>a real mission report unlocked warzone-service's own seeded "warzone_first_blood"<br/>achievement and granted XP, with no ZG_COMPUTE_API_KEY configured.
```

## 3. Cross-game reward fan-out (replaces the warzoneGunRewardClient.js hack)

```mermaid
sequenceDiagram
    participant Adapter as sync-service
    participant NATS
    participant Achievement as Achievement Service
    participant Reward as Reward Service
    participant Notification as Notification Service
    participant PG as PostgreSQL

    Adapter->>NATS: game.zerodash.game_saved { coinSnapshot: 12, ... }
    par achievement evaluation
        NATS->>Achievement: deliver
        Achievement->>PG: check/insert UserAchievement
        Achievement->>NATS: publish platform.achievement.unlocked
    and reward evaluation
        NATS->>Reward: deliver
        Reward->>PG: load Reward rows, matchesEventCriteria(reward.criteria, event)?
        Reward->>PG: insert UserReward { rewardKey, sourceGame: zerodash }
        Reward->>NATS: publish platform.reward.granted { targetGameKey: warzone }
    end
    NATS->>Notification: deliver platform.reward.granted
    Notification->>Notification: log / push / email (stub today)
    Note over Reward,PG: ZeroDash never calls Warzone's API and never knows it exists.<br/>Compare to warzoneGunRewardClient.js, which hardcoded Warzone's URL<br/>and a shared secret string directly in ZeroDash's source.
```
