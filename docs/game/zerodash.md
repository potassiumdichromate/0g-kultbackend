# ZeroDash — Integration Guide

How this game actually works today (Unity client + its own backend), and how it plugs into the `0g-kultbrowser` platform. Nothing described as "today"/"existing" here was modified to produce this doc — both the backend repo and the Unity project were only read.

- Backend repo: `C:\Users\RENTKAR\Desktop\0g-ai\0g-Zerodash\zerodash-0g-backend`
- Unity project: `C:\Users\RENTKAR\Desktop\Projects\TempleEscape\Assets`
- Platform adapter: [`services/game-adapters/zerodash-adapter`](../../services/game-adapters/zerodash-adapter)

## 1. What this game is

A Unity WebGL runner/arcade game (coins, high score, unlockable characters, an NFT membership pass, a daily reward) with a wallet-based identity, a save anchored to 0G Storage/Chain/DA, and a basic cross-game reward mechanism that today directly calls Warzone Warriors' API (see §9 — this is the exact coupling the platform's `reward-service` replaces).

## 2. Backend architecture (today, unmodified)

Node.js/Express + MongoDB(Mongoose). Layout:

```
src/
├── server.js                  — Express app, CORS, route mounting, /blockchain-info, /stats, /contracts
├── config/db.js               — MongoDB connection
├── middleware/auth.js         — JWT verification
├── models/
│   ├── Player.js              — game profile: coins, highScore, nftPass, characters, dailyReward (see §5)
│   ├── PlayerSaveRecord.js    — save metadata + 0G pipeline status
│   └── AuthNonce.js           — SIWE nonce, 5-min TTL
├── controllers/
│   ├── authController.js      — nonce issuance + login
│   ├── player.controller.js   — legacy profile/leaderboard/NFT-pass/sessions endpoints
│   ├── zgController.js        — binary save/load, metadata, verify, decentralized leaderboard
│   └── zgUXController.js      — dashboard/activity/badge/proof/explorer endpoints
├── routes/
│   ├── authRoutes.js, player.routes.js, profileRoutes.js, zgUXRoutes.js
│   └── crossGameRoutes.js     — cross-game progress aggregation (see §9)
├── services/
│   ├── ZeroGStorage.js        — 0G Storage upload/download
│   ├── ZeroGChain.js          — PlayerSaveAnchor.sol calls
│   ├── ZeroGDA.js             — gRPC to 0G DA disperser
│   ├── ZeroGCompute.js        — anti-cheat via 0G Compute
│   ├── crossGameService.js    — fetches progress from 3 other game backends by hardcoded URL
│   └── warzoneGunRewardClient.js — hardcoded Warzone URL + shared-secret string, grants a gun unlock directly
├── blockchain/{sessionService.js, leaderboardService.js}
└── utils/{retry.js, crossGameDifficulty.js}
```

## 3. 0G integration (today, unmodified)

Same four layers as Warzone Warriors (this repo and `warzone-backend-0g` were built from a near-identical template):

| Layer | File | Notes |
|---|---|---|
| Storage | `ZeroGStorage.js` | Same upload/download/indexer-rotation/retry pattern |
| Chain | `ZeroGChain.js` + `contracts/PlayerSaveAnchor.sol` | Same anti-rollback anchor contract shape, 0G Mainnet chainId 16661 |
| DA | `ZeroGDA.js` + `protos/disperser.proto` | Same gRPC dispersal/polling |
| Compute | `ZeroGCompute.js` | Anti-cheat only here (no AI/behavioral-training feature in this repo, unlike Warzone) |

## 4. Auth flow (today, unmodified)

Identical SIWE pattern to Warzone Warriors: `GET /auth/nonce?wallet=` → sign → `POST /auth/login` → HS256 JWT, `{walletAddress, sub}`, 7-day expiry. The signed message text says "Sign in to ZeroDash" instead of "WarzoneWarrior" — the only difference between the two repos' auth flows.

## 5. Save data model & binary wire format (today, unmodified)

**Legacy Mongoose schema** (`src/models/Player.js`, collection `Player`):

```
walletAddress, coins, highScore, nftPass,
characters{unlocked: [String], currentIndex},
dailyReward{nextRewardAt: Date}
```

**Unity side** (`Assets/_TempleEscape/Scripts/Savestate/ZGSaveManager.cs`) uses a *different, flatter* shape and a *custom raw-binary* encoding — not JSON-then-frame like Warzone:

```csharp
class PlayerSaveData {
  int Coins; int HighScore; bool NftPass;
  int CurrentCharacterIndex; List<string> UnlockedCharacters;
  long NextDailyRewardTimestamp; // unix seconds
}
```

Wire format ("ZDSV"), built with .NET `BinaryWriter`/`BinaryReader` — no JSON, no compression:

```
[4 bytes] Magic "ZDSV"
[1 byte]  Version 0x01
[4 bytes] Coins (int32)
[4 bytes] HighScore (int32)
[1 byte]  NftPass (bool)
[4 bytes] CurrentCharacterIndex (int32)
[4 bytes] UnlockedCharacters count, then each as BinaryWriter 7-bit-length-prefixed UTF8 string
[8 bytes] NextDailyRewardTimestamp (int64)
```

Note the field-name and shape mismatch with the legacy Mongoose model above (`characters.unlocked`/`characters.currentIndex` nested vs. `CurrentCharacterIndex`/`UnlockedCharacters` flat, and no `dailyReward` nesting) — the binary endpoint and the legacy JSON endpoint are two independent representations of overlapping data; the binary one is what the live client actually uses today.

## 6. Unity client structure (today, unmodified)

- **`GameBootstrapper.cs`** — on boot, gets the JWT either from a URL `?token=` param (standalone) or via `SendMessage("SetJwtToken", ...)` from a JS/React bridge (inline mode); stores it in `BackendService`/`PlayerPrefs`. Calls `ZGSaveManager.LoadSave()`; on 404 (first-time player), uploads `ZGSaveManager.DefaultSave()`; on network error, falls back entirely to local `PlayerPrefs`.
- **`BackendService.cs`** — holds the static `GameData` cache (`Coins`, `HighScore`, `NftPass`, `CurrentCharacter`, `UnlockedCharacters`, `IsLoaded`); `UpdateGameData(coins, highScore)` updates the cache + `PlayerPrefs` but does **not** call the backend.
- **`ZGSaveManager.cs`** — `Serialize`/`Deserialize` (the ZDSV binary above) and `UploadSave`/`LoadSave` (`POST`/`GET` `{BASE_URL}/player/save/binary`, `/player/load/binary`, `Authorization: Bearer <jwt>`). `BASE_URL = "https://zerog-zerodash.onrender.com"` (confirmed live and serving real player data — see `Knowledge_Base.md`).
- **Save trigger — only one path actually reaches the backend**: `GameManager.GameOver()` calls `BackendService.SavePlayerProfile()` once per session. `CoinManager.AddCoins()`/`ScoreManager.UpdateHighScore()` only update the in-memory cache + `PlayerPrefs`; **no autosave loop, no per-pickup backend write** — meaningfully lower save frequency than Warzone Warriors (see `docs/game/warzonewarriors.md` §6 for the contrast, which is the basis for the production note in `architecture/08-migration-roadmap.md`).
- **Character unlocks** (`Character.cs`, `CharacterManager.cs`) are tracked purely in local `PlayerPrefs` keyed by character name/a fixed key, separately from the binary save's `UnlockedCharacters` list — synced into that list at save time.

## 7. API endpoint reference (today, unmodified)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/auth/nonce?wallet=` | none | SIWE nonce + message |
| POST | `/auth/login` | none | signature → JWT |
| POST | `/player/save/binary` | JWT | upload ZDSV-equivalent binary (Unity's own framing — backend expects the WZSV-style 5-byte-header + JSON variant per `zgController.js`; see note below) |
| GET | `/player/load/binary` | JWT | download latest binary |
| GET | `/player/save/metadata?wallet=` | none | last 10 saves + on-chain anchor status (used by `zerodash-adapter`) |
| GET | `/player/verify?wallet=` | none | 4-layer integrity check |
| GET | `/player/leaderboard/decentralized` | none | top 100 by `coinSnapshot` (used by `zerodash-adapter`) |
| GET/POST | `/player/profile`, `/player/save` (legacy JSON), `/player/leaderboard`, `/player/nft-pass`, `/player/sessions`, `/player/blockchain-stats`, `/player/leaderboard-snapshot/:id`, `/player/leaderboard-history` | mixed | legacy/auxiliary game data, dual-written to 0G in the background |
| GET | `/cross-game/local`, `/cross-game/progress` | none | cross-game aggregation (see §9) |
| GET | `/0g/dashboard`, `/0g/activity`, `/0g/badge`, `/0g/network`, `/0g/proof/:wallet/:saveIndex`, `/0g/leaderboard/verified`, `/0g/explorer/:wallet` | mixed | trust-score/UX dashboard endpoints |

**Note on the binary format mismatch:** the backend's `zgController.js` was originally analyzed (Round 1) expecting a 5-byte magic+version header followed by raw JSON (same shape as Warzone's WZSV). The Unity client's `ZGSaveManager.cs` (read in Round 2) instead writes a fully custom packed-binary "ZDSV" frame with no embedded JSON at all. Both can't be literally true of the same live deployment — flag this discrepancy to whoever owns this repo before relying on the exact byte layout; it doesn't affect anything in this platform, since the adapter only ever calls the public JSON metadata/leaderboard endpoints, never the binary save endpoint directly.

## 8. How this game plugs into `0g-kultbrowser` today (Phase 1 bridge — not the target, see §10)

`services/game-adapters/zerodash-adapter` polls `GET /player/leaderboard/decentralized`, diffs `saveIndex` per wallet against a Redis cursor, fetches `GET /player/save/metadata?wallet=` on change, and publishes `game.zerodash.game_saved` to NATS. **This was the one fully live-verified path in this platform** — pointed at the real `https://zerog-zerodash.onrender.com`, it picked up 18 real players' saves with real rootHashes in its first poll cycle, and `profile-service` correctly mirrored `(rootHash, saveIndex, coinSnapshot)` into `UserGameProgress` (see `Knowledge_Base.md` for the full trace). Zero code changes to this repo.

Like Warzone's adapter, this is a **compatibility bridge, not the platform's target architecture** for this game (see `architecture/00-platform-vision.md`) — it exists only because this repo hasn't migrated onto `save-service` yet (§10). It's also, conveniently, the easier of the two games to migrate (see §10's note on save frequency).

## 9. The hack this platform replaces

`crossGameService.js` hardcodes the backend URLs of three other games (ZeroGPool, GuessTheAI, Highway Hustle) and calls them directly to aggregate "cross-game progress." `warzoneGunRewardClient.js` goes further: it hardcodes Warzone Warriors' URL **and a literal shared-secret string committed to source** (`'warzone-gun-cross-game-reward-v1'`), used to call Warzone's API directly and grant a shotgun unlock once this game's coin balance crosses a "medium" difficulty threshold (`crossGameDifficulty.js`, thresholds easy=4/medium=8/hard=12).

The platform's `reward-service` (`services/reward-service/src/reward.consumer.ts`) reimplements the same threshold logic generically: it listens for `game.zerodash.game_saved` events with `coinSnapshot >= 8`, grants a `cross_game_warzone_shotgun` reward record, and publishes `platform.reward.granted` — **ZeroDash's code never calls Warzone's API and never needs to know Warzone exists.** This was live-verified with a real `coinSnapshot: 12` event correctly triggering the grant. Actually delivering the unlock *into* Warzone's own database (rather than just recording the grant on the platform side) is a documented future step, since the platform doesn't write to either game's database — see `architecture/08-migration-roadmap.md`.

## 10. Path to the managed save pipeline (Phase 3 — the committed target for this game, already partially live-tested)

This is the platform's actual destination for ZeroDash, not an optional side door (see `architecture/00-platform-vision.md` and `architecture/08-migration-roadmap.md` Phase 3). What's undecided is *when*, not *whether* — and of the two existing games, this one is the cheaper migration (see the note on save frequency below).

`ZeroDashSaveDataSchema` in `shared/dto/src/save-data.dto.ts` is built from §5/§6 above (`coins`, `highScore`, `nftPass`, `characters.unlocked`/`currentIndex`, `dailyReward.nextRewardAt` as unix seconds — matching the legacy Mongoose field names, with the timestamp semantics taken from the real Unity client). `save-service`'s `POST /save/zerodash` / `GET /save/zerodash` were live-tested against this exact schema in `Knowledge_Base.md` (Round 2) — including a full Redis-flush-and-recover test proving 0G Storage, not Redis, is the real source of truth.

The only change required is in Unity (this platform never modifies this repo's source): in `ZGSaveManager.cs`, replace the ZDSV `Serialize`/`Deserialize`/`UploadSave`/`LoadSave` calls with a plain `JsonConvert.SerializeObject`/`DeserializeObject` POST/GET against `save-service`. Given this client only saves once per session (§6), no debounce work is needed first — unlike Warzone Warriors, this migration is "just" the encoding swap.

**Once this migration completes**, `zerodash-adapter` (§8) is retired and `verification-service` becomes this game's anti-cheat going forward — this repo's own `ZeroGCompute.js` simply stops being called rather than being merged with the platform's implementation (those two stay separate by design — see `docs/architecture-explanation.md`).

## 11. Anti-patterns flagged in this repo (for context, not fixed by the platform)

- Secrets in code: `warzoneGunRewardClient.js`'s shared-secret string, hardcoded rather than an env var.
- `crossGameService.js`'s hardcoded list of 4 other games' backend URLs — exactly the coupling NATS events replace.
- Loose JWT-secret validation (warns but doesn't fail if `BROWSER_JWT_SECRET` is left at its dev default).
- `PATCH`-style profile updates accept any top-level field via `Object.entries(body)` with no allowlist.
- No request-size/anti-cheat validation between the legacy JSON profile endpoint and the binary endpoint — the two paths can disagree about a player's state.

See `Knowledge_Base.md`'s first session entry for the full original analysis this guide is drawn from.
