# Repository Mapping

What in the two existing repos maps to what in this platform. Built from a full read-through of both codebases (see the session log in [../Knowledge_Base.md](../Knowledge_Base.md) for the detailed findings). Neither existing repo was modified to produce this table or this platform.

**For a full, per-game integration guide** (backend architecture, 0G integration, auth, save format, Unity client structure, every API endpoint, and the exact platform integration path) see [game/warzonewarriors.md](./game/warzonewarriors.md) and [game/zerodash.md](./game/zerodash.md). This doc stays focused on the cross-game patterns; those two go deep on one game each.

## Duplicated infrastructure (identical or near-identical in both repos → extracted to `shared/`)

| Existing file (both repos, same path) | What it does | New home |
|---|---|---|
| `src/utils/retry.js` | Exponential backoff wrapper | `shared/utils/src/retry.ts` (`withRetry`) |
| `src/middleware/auth.js` | JWT extraction/verification, raw-wallet rejection | `shared/utils/src/jwt.ts` + `services/api-gateway/src/auth.guard.ts` |
| `src/controllers/authController.js` | SIWE nonce + signature verify + JWT mint | `services/identity-service/src/auth.routes.ts` |
| `src/models/AuthNonce.js` | Single-use, TTL'd nonce storage | Redis key `auth:nonce:<wallet>` (see `shared/utils/src/redis-client.ts`) |
| `src/models/PlayerSaveRecord.js` | Save metadata + 0G pipeline status | `UserGameProgress` table (`shared/db/prisma/schema.prisma`) — rootHash is now metadata, not a per-game column |
| `contracts/PlayerSaveAnchor.sol` | On-chain anti-rollback anchor | Unchanged, still owned and called by each game backend — the platform never touches it |
| `protos/disperser.proto` + `src/services/ZeroGDA.js` | gRPC DA dispersal | Unchanged, still owned by each game backend |
| `src/services/ZeroGStorage.js` / `ZeroGChain.js` | 0G Storage upload/download, chain anchoring | For the zero-touch path: unchanged, still owned by each game backend. **For the managed pipeline (Round 2):** the storage-upload/download *pattern* (temp file, Merkle root, indexer rotation, retry) is ported — not duplicated again — into `shared/zg-client/src/storage.ts`, used by `save-service`. The on-chain anchor (`ZeroGChain.js`/`PlayerSaveAnchor.sol`) was not ported; the managed pipeline doesn't currently anchor on-chain (see open items in `Knowledge_Base.md`) |
| `src/services/ZeroGCompute.js` (anti-cheat half) | 0G Compute TEE anti-cheat client: OpenAI-compatible call, rootHash-echo binding check, graceful skip with no API key | **Round 2:** ported into `shared/zg-client/src/compute.ts`, used by the new `verification-service`. Same graceful-skip behavior, verified live with no `ZG_COMPUTE_API_KEY` configured — see `Knowledge_Base.md`. The zero-touch path is unaffected; each game still calls its own copy and the adapter mirrors the verdict |
| Trust-score / badge endpoints (`zgUXController.js`, both repos) | Pipeline status → user-facing trust score | Pattern noted in `architecture/01-system-overview.md`; not yet ported (no consumer needs it today) |

## Game-specific logic (NOT extracted, stays in each repo)

| File | Why it stays put |
|---|---|
| `zerodash-0g-backend/src/models/Player.js` | ZeroDash's own profile shape (coins, highScore, characters) — irrelevant to other games |
| `warzone-backend-0g/src/models/PlayerProfile.js` | Warzone's own profile shape (campaign, rambos, guns, grenades) |
| `warzone-backend-0g/src/services/ZeroGCompute.js` system prompts | Anti-cheat rules specific to Warzone's resource caps and progression |
| `zerodash-0g-backend/src/utils/crossGameDifficulty.js` | ZeroDash-specific difficulty thresholds — the *concept* (event-driven cross-game reward) is generalized into `reward-service`, the thresholds themselves are not |

## The hack this platform replaces

| Existing file | Problem | Replacement |
|---|---|---|
| `zerodash-0g-backend/src/services/crossGameService.js` | Hardcoded list of other games' backend URLs, called directly from ZeroDash | `game-adapters/*` + NATS events — ZeroDash's code never needs this list |
| `zerodash-0g-backend/src/services/warzoneGunRewardClient.js` | Hardcoded Warzone URL + a literal shared-secret string (`'warzone-gun-cross-game-reward-v1'`) committed to source, used to call Warzone's API directly | `services/reward-service/src/reward.consumer.ts` — listens for the same `coinSnapshot` threshold via `game.zerodash.game_saved`, grants the reward in the platform DB, publishes `platform.reward.granted`. Verified live: a synthetic `coinSnapshot >= 8` save event correctly granted `cross_game_warzone_shotgun` with zero ZeroDash-to-Warzone coupling. (Actually delivering the unlock *into* Warzone's own database is a documented future step — see `architecture/08-migration-roadmap.md` — since no current phase can write to Warzone's database without modifying it.) |

## Unity client mapping (Round 2 — read-only exploration, not modified)

Read the actual Unity source for both games to ground the managed save pipeline's contract in reality, not guesswork:

| Unity file | What it does today | Informs |
|---|---|---|
| `Metal Black OPS/Assets/_Assets/Web3Integ/ZGSaveManager.cs` | Builds the full nested `PlayerProfile`/`PlayerResources`/`PlayerRambos`/.../`PlayerTutorialData` JSON (Newtonsoft), wraps it in a "WZSV" magic-header binary frame, no compression | `WarzoneSaveDataSchema` in `shared/dto/src/save-data.dto.ts` — same field names, JSON-only |
| `Metal Black OPS/Assets/_Assets/Web3Integ/BackendSyncManager.cs` | `UploadSave`/`LoadSave` against `/player/save/binary`/`/player/load/binary` with `Authorization: Bearer <jwt>`; **17+ save trigger call sites** (coin/gem/stamina/medal/ticket, level-up, gun/grenade/rambo upgrade, campaign/quest/achievement/tutorial progress) plus a 25s autosave loop | The save-frequency production note in `architecture/08-migration-roadmap.md` Phase 3 — the managed pipeline is correct as built, but a noisy client would hit 0G Storage far more than necessary until debounced client-side |
| `TempleEscape/Assets/_TempleEscape/Scripts/Savestate/ZGSaveManager.cs` | Flat `PlayerSaveData{Coins, HighScore, NftPass, CurrentCharacterIndex, UnlockedCharacters, NextDailyRewardTimestamp}`, encoded with raw `BinaryWriter` (custom "ZDSV" header, no JSON, no compression) | `ZeroDashSaveDataSchema` in `shared/dto/src/save-data.dto.ts` |
| `TempleEscape/Assets/_TempleEscape/Scripts/Savestate/{BackendService.cs, GameBootstrapper.cs}` | JWT from a React-frontend URL/`SendMessage` bridge after SIWE; **save only fires once per session**, on `GameManager.GameOver()` | Confirms the JWT claim shape `identity-service` already issues is a drop-in fit; confirms ZeroDash's lower save frequency needs no client-side change unlike Warzone's |

Neither Unity project was modified — this is purely how the managed pipeline's JSON contract and the production note above were derived.

## Endpoints the adapters depend on (read-only, already public)

| Endpoint | Present in | Used by |
|---|---|---|
| `GET /player/leaderboard/decentralized` | Both repos | `shared/utils/src/polling-adapter.ts` — discovers active wallets + current `saveIndex` |
| `GET /player/save/metadata?wallet=0x...` | Both repos | Same file — fetches `rootHash`/`checksum`/`daStatus` once a `saveIndex` change is detected |

If either endpoint's response shape changes in the existing repos, only `shared/utils/src/polling-adapter.ts` needs updating — no other service knows these endpoints exist.
