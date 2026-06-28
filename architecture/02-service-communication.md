# Service Communication

**Read [00-platform-vision.md](./00-platform-vision.md) first.** Flow 2 below is the *transitional* path ZeroDash/Warzone use today; flow 2b is the platform-owned save pipeline that's the actual target for every game, including those two once migrated (see [08-migration-roadmap.md](./08-migration-roadmap.md)). All sequence diagrams are Mermaid — view in any Markdown renderer that supports it (GitHub, VS Code preview, etc.).

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
    participant Adapter as zerodash-adapter
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

## 2b. Save flow — THE TARGET (platform owns the entire pipeline; live-verified, used by no real game yet)

```mermaid
sequenceDiagram
    participant Unity as Unity Client
    participant GW as API Gateway
    participant Save as Save Service
    participant Redis
    participant ZG as 0G Storage (or local-disk driver)
    participant PG as PostgreSQL
    participant NATS
    participant Verify as Verification Service

    Unity->>GW: POST /api/v1/save/<gameKey> { ...plain JSON... } (Bearer JWT)
    GW->>Save: proxy
    Save->>Save: validate against per-game Zod schema; wallet from JWT, never body
    Save->>NATS: publish game.<gameKey>.save_requested
    Save->>Redis: SET cache:save:<gameKey>:<wallet> (fast working copy — not the source of truth)
    Save->>Save: msgpack-encode, gzip-compress
    Save->>ZG: upload(buffer) -> rootHash
    Save->>PG: upsert UserGameProgress { rootHash, saveIndex, metadata } (pointer only, never the JSON)
    Save->>NATS: publish game.<gameKey>.save_completed AND game.<gameKey>.game_saved (same payload)
    Save-->>Unity: { rootHash, saveIndex }

    NATS->>Verify: deliver save_completed
    Verify->>Verify: coinDelta/saveIndexDelta check (threshold from GameMetadata)
    Verify->>ZG: (if 0G Compute configured) anti-cheat call; else skip gracefully
    Verify->>PG: merge computeStatus/verdict into UserGameProgress.metadata
    Verify->>NATS: publish game.<gameKey>.save_validated

    Note over Unity,PG: Verified live: deleting the Redis key and re-loading still returns<br/>the exact original JSON, recovered from the storage driver — proof<br/>0G Storage, not Redis, is the real source of truth.
```

Load is the mirror: `GET /api/v1/save/<gameKey>` checks Redis first, falls back to Postgres → 0G Storage → decode → repopulate Redis on a cache miss.

## 3. Cross-game reward fan-out (replaces the warzoneGunRewardClient.js hack)

```mermaid
sequenceDiagram
    participant Adapter as zerodash-adapter
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
        Reward->>Reward: coinSnapshot >= threshold?
        Reward->>PG: insert UserReward { rewardKey, sourceGame: zerodash }
        Reward->>NATS: publish platform.reward.granted { targetGameKey: warzone }
    end
    NATS->>Notification: deliver platform.reward.granted
    Notification->>Notification: log / push / email (stub today)
    Note over Reward,PG: ZeroDash never calls Warzone's API and never knows it exists.<br/>Compare to warzoneGunRewardClient.js, which hardcoded Warzone's URL<br/>and a shared secret string directly in ZeroDash's source.
```
