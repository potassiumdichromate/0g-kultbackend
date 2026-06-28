# Warzone Warriors — Integration Guide

How this game actually works today (Unity client + its own backend), and how it plugs into the `0g-kultbrowser` platform. Nothing described as "today"/"existing" here was modified to produce this doc — both the backend repo and the Unity project were only read.

- Backend repo: `C:\Users\RENTKAR\Desktop\0g-ai\0g-Warzone\warzone-backend-0g`
- Unity project: `C:\Users\RENTKAR\Desktop\Projects\Warzone\Metal Black OPS\Assets`
- Platform adapter: [`services/game-adapters/warzone-adapter`](../../services/game-adapters/warzone-adapter)

## 1. What this game is

A Unity WebGL action game (campaign stages, characters called "Rambos," guns/grenades/melee weapons, daily quests, achievements, boosters) with a wallet-based identity and a save file that's anchored to 0G Storage/Chain/DA, plus an 0G-Compute-backed anti-cheat and in-game AI system.

## 2. Backend architecture (today, unmodified)

Node.js/Express + MongoDB(Mongoose). Layout:

```
src/
├── server.js                  — Express app, CORS, route mounting
├── config/db.js               — MongoDB connection
├── middleware/auth.js         — JWT verification (Bearer header or body jwt)
├── models/
│   ├── PlayerProfile.js       — WarzonePlayerProfile: full game state (see §5)
│   ├── PlayerSaveRecord.js    — save metadata + 0G pipeline status
│   ├── AuthNonce.js           — SIWE nonce, 5-min TTL
│   └── AIRecord.js            — behavioral-AI training metadata
├── controllers/
│   ├── authController.js      — nonce issuance + login
│   ├── player.controller.js   — profile/leaderboard CRUD
│   ├── zgController.js        — binary save/load, verify, decentralized leaderboard
│   ├── behaviorController.js  — AI training sample upload/status
│   ├── aiController.js        — AI inference (predict/strategy)
│   └── zgUXController.js      — dashboard/activity/badge/proof/explorer endpoints
├── services/
│   ├── ZeroGStorage.js        — 0G Storage upload/download
│   ├── ZeroGChain.js          — PlayerSaveAnchor.sol calls (anti-rollback anchor)
│   ├── ZeroGDA.js             — gRPC to 0G DA disperser
│   ├── ZeroGCompute.js        — anti-cheat + AI inference via 0G Compute
│   └── BehaviorTrainer.js     — TF.js model training/inference
├── blockchain/
│   ├── sessionService.js      — SessionTracker contract bindings
│   └── leaderboardService.js  — LeaderboardTracker contract bindings
└── utils/{retry.js, aiEncoder.js}
```

## 3. 0G integration (today, unmodified)

| Layer | File | What it does |
|---|---|---|
| Storage | `ZeroGStorage.js` | Uploads/downloads the binary save via `@0gfoundation/0g-storage-ts-sdk`; temp file → Merkle tree → indexer upload (rotates across 3 indexer endpoints on failure); retry with backoff |
| Chain | `ZeroGChain.js` + `contracts/PlayerSaveAnchor.sol` | Anchors `(wallet, rootHash, saveIndex)` on 0G Mainnet (chainId 16661); contract enforces `saveIndex` strictly increases (anti-rollback) |
| DA | `ZeroGDA.js` + `protos/disperser.proto` | gRPC `DisperseBlob`/`GetBlobStatus` to the 0G DA disperser; polls until `FINALIZED` or times out at 240s |
| Compute | `ZeroGCompute.js` | Two uses: (1) anti-cheat — triggered when `coinDelta` is large or `saveIndexDelta >= 1`, sends save delta to an LLM via the 0G Compute router, checks a rootHash-echo binding, reads `teeVerified` from response trace headers; (2) AI — hybrid local-TF.js / 0G-Compute-LLM inference for in-game bot behavior |

All four remain entirely owned by this repo. The platform never calls any of them directly for this game — see §7.

## 4. Auth flow (today, unmodified)

SIWE-style: `GET /auth/nonce?wallet=0x...` → sign the returned message → `POST /auth/login {wallet, signature, nonce}` → `ethers.verifyMessage()` recovers the signer, compares to the claimed wallet → issues an HS256 JWT, 7-day expiry, claims `{walletAddress, sub}`. Nonce is single-use (deleted from Mongo on any login attempt) and TTL'd at 5 minutes.

## 5. Save data model & binary wire format (today, unmodified)

**Mongoose schema** (`src/models/PlayerProfile.js`, collection `WarzonePlayerProfile`):

```
walletAddress, Intraverse{userId,userName},
PlayerProfile{level, exp, totalTimePlayed},
PlayerResources{coin, gem, stamina, medal, tournamentTicket},
PlayerRambos: Map<id, {id, level}>,
PlayerRamboSkills: Map<id, Map<skillId, value>>,
PlayerGuns: Map<id, {id, level, ammo, isNew}>,
PlayerGrenades: Map<id, {id, level, quantity, isNew}>,
PlayerMeleeWeapons: Map<id, {id, level, isNew}>,
PlayerCampaignProgress (legacy, dot-key-encoded, usually empty),
PlayerCampaignStageProgress: Map<"stageId", [bool,bool,bool]>,
PlayerCampaignRewardProgress: Map<mapId, [bool,...]>,
PlayerBoosters: Map<boosterType, qty>,
PlayerSelectingBooster: [boosterType, ...],
PlayerDailyQuestData: [{type, progress, isClaimed}],
PlayerAchievementData: Map<achId, {type, progress, claimTimes}>,
PlayerTutorialData: Map<tutorialType, bool>
```

**Unity side** (`Assets/_Assets/Web3Integ/ZGSaveManager.cs`) builds the *identical* JSON shape (Newtonsoft `JObject`, exact same field names — `PlayerProfile`, `PlayerResources`, etc.) and wraps it before sending to the backend:

```
[Byte 0-3] Magic "WZSV" (0x57 0x5A 0x53 0x56)
[Byte 4]   Version 0x01
[Byte 5+]  UTF-8 JSON payload, minified, NOT compressed
```

`Serialize()`/`Deserialize()` in that file are the encode/decode pair; no MessagePack, no gzip — plain JSON inside a 5-byte frame.

## 6. Unity client structure (today, unmodified)

- **`ProfileManager`** — singleton holding the static `UserProfile`; every sub-data object (`_PlayerResourcesData`, `_PlayerGunData`, etc.) exposes mutators that call `.Save()`, which calls `ProfileManager.SaveAll()` → writes encrypted `PlayerPrefs` locally, then (outside Editor/Server builds) kicks off `BackendSyncManager.SavePlayerDataToBackend(...)`.
- **`BackendSyncManager.cs`** — `UploadSave(jwt, onDone)` builds the WZSV binary and `POST`s it to `{BASE_URL}/player/save/binary` (`Content-Type: application/octet-stream`, `Authorization: Bearer <jwt>`). `LoadSave(jwt, ...)` does the reverse `GET {BASE_URL}/player/load/binary`. Also has `GetNonce`/`Login` wrapping the auth endpoints. `BASE_URL = "https://zerog-warzonewarriors.onrender.com"`.
- **JWT acquisition**: a React frontend handles wallet connect + SIWE, then hands Unity the JWT via a `?jwt=` URL param (stored in `PlayerPrefs["ZGJwt"]`). Unity never does the signing itself.
- **Save trigger call sites** (17+, each re-uploads the *entire* profile): coin/gem/stamina/medal/tournament-ticket pickup, level-up (`ReceiveExp`), gun/grenade/rambo level-up or acquisition, campaign stage/reward progress, booster receive/consume, daily-quest progress/claim, achievement progress/claim, tutorial completion/skip, plus a **25-second autosave loop** (`TotalTimeTracker_AutoSave`) and app pause/quit.
- **Load**: on boot, `Login.cs` triggers `BackendSyncManager.LoadPlayerDataFromBackend()`; on success, `ZGSaveManager.Deserialize()` parses the WZSV binary and writes every field back into `ProfileManager`.

## 7. API endpoint reference (today, unmodified)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/auth/nonce?wallet=` | none | SIWE nonce + message |
| POST | `/auth/login` | none | signature → JWT |
| POST | `/player/save/binary` | JWT | upload WZSV binary; background pipeline: 0G Storage → chain anchor → DA → conditional anti-cheat |
| GET | `/player/load/binary` | JWT | download latest WZSV binary |
| GET | `/player/save/metadata?wallet=` | none | last 10 saves + on-chain anchor status (used by `warzone-adapter`, see §8) |
| GET | `/player/verify?wallet=` | none | 4-layer integrity check |
| GET | `/player/leaderboard/decentralized` | none | top 100 by `coinSnapshot` (used by `warzone-adapter`, see §8) |
| GET | `/player/profile`, `/player/leaderboard`, `/player/sessions`, `/player/blockchain-stats` | mixed | legacy/auxiliary game data |
| POST | `/behavior/upload`, GET `/behavior/status/:wallet` | mixed | AI training samples |
| POST | `/ai/predict`, `/ai/strategy` | none | hybrid AI inference |
| GET | `/0g/dashboard`, `/0g/activity`, `/0g/badge`, `/0g/network`, `/0g/proof/:wallet/:saveIndex`, etc. | mixed | trust-score/UX dashboard endpoints |

## 8. How this game plugs into `0g-kultbrowser` today (zero-touch, Phase 1)

`services/game-adapters/warzone-adapter` polls `GET /player/leaderboard/decentralized` on an interval (`ADAPTER_POLL_INTERVAL_MS`), diffs each wallet's `saveIndex` against a Redis-stored cursor, and on a change fetches `GET /player/save/metadata?wallet=` to get the real `rootHash`/`checksum`/`daStatus`, then publishes `game.warzone.game_saved` to NATS. **Zero code changes to this repo.** From there, `profile-service` mirrors `(rootHash, saveIndex)` into `UserGameProgress`, and `achievement-service`/`reward-service`/`leaderboard-service`/`analytics-service` react to the same event — see `architecture/02-service-communication.md` for the sequence diagram.

`identity-service` issues JWTs with the exact `{walletAddress, sub}` HS256 claim shape this repo's own `middleware/auth.js` already expects — pointing this game's `BROWSER_JWT_SECRET` at the platform's secret (a config change, not a code change) would let a platform-issued login work against this game's existing endpoints unmodified, if that's ever wanted.

**Known gap:** the real deployed backend URL for the adapter is still unconfirmed (`WARZONE_BACKEND_URL` in `.env.example` is a placeholder guess that 404s) — the Unity client's actual `BASE_URL` (`https://zerog-warzonewarriors.onrender.com`, found in `BackendSyncManager.cs`) is a stronger candidate and should be tried before assuming the adapter is broken.

## 9. Path to the managed save pipeline (Phase 3, opt-in, not done)

If this game's owner ever wants to retire the Unity-side WZSV encoding (see `architecture/08-migration-roadmap.md` Phase 3):

1. `WarzoneSaveDataSchema` already exists in `shared/dto/src/save-data.dto.ts`, built field-for-field from §5/§6 above — no new schema work needed.
2. Unity change (not made by this platform, and not required unless the owner opts in): in `ZGSaveManager.cs`/`BackendSyncManager.cs`, replace `Serialize()`/`UploadSave` with a plain `JsonConvert.SerializeObject(payload)` POST to `save-service`'s `POST /save/warzone`, and replace `Deserialize()`/`LoadSave` with a plain `GET /save/warzone` JSON parse. The JWT handling is unchanged — `save-service` accepts the same Bearer token shape.
3. **Before doing this, read the production note in `architecture/08-migration-roadmap.md` Phase 3 and `architecture/09-security-model.md`:** this game's client fires a save on 17+ different micro-events plus a 25-second autosave loop, each currently a full-profile WZSV upload. Pointed at `save-service` unmodified, that's a real 0G Storage write per coin pickup. Debounce/coalesce client-side (flush on a short timer, or on "significant" events only — closer to how ZeroDash's client already behaves) before switching this game onto the managed pipeline.

## 10. Anti-patterns flagged in this repo (for context, not fixed by the platform)

- `console.log`-only logging, no structured logger.
- CORS allowlist hardcoded in `server.js` source rather than env-driven.
- `PlayerProfile.js`'s dot-key-encoding workaround (`__dot__`) for legacy `PlayerCampaignProgress` keys — fragile if a real key ever contains that literal substring.
- Anti-cheat/AI system prompts hardcoded in `ZeroGCompute.js`, making them impossible to tune without a redeploy (the platform's `verification-service` reads its threshold from `GameMetadata` instead — see `architecture/03-database-diagram.md`).
- No checksum re-verification on download in `ZeroGStorage.js`.

See `Knowledge_Base.md`'s first session entry for the full original analysis this guide is drawn from.
