# Event Flow

See [00-platform-vision.md](./00-platform-vision.md) for the principle behind this catalogue: events are how the platform learns what happened without owning the game's gameplay logic, and how every platform service stays generic (game-agnostic) instead of hardcoding a game list.

## Event catalogue

| Event | Producer | Consumers | Payload schema |
|---|---|---|---|
| `game.<key>.game_saved` | Game adapter (Phase 1), game's own SDK (Phase 2), **or save-service (Phase 3, managed pipeline)** | Profile, Leaderboard, Achievement, Reward, Analytics | `GameSavedPayloadSchema` |
| `game.<key>.mission_completed` | Game (Warzone-style games) — *no live producer yet, see below* | Achievement, Reward, Analytics | `MissionCompletedPayloadSchema` |
| `game.<key>.level_up` | Game — *no live producer yet, see below* | Achievement, Reward, Analytics | `LevelUpPayloadSchema` |
| `game.<key>.game_finished` | Game — *no live producer yet* | Leaderboard, Analytics | `GameFinishedPayloadSchema` |
| `game.<key>.game_installed` | Reserved — *no live producer yet* | Analytics | `GameInstalledPayloadSchema` |
| `game.<key>.save_requested` | **Save Service**, the instant a save POST is received | Analytics | `SaveRequestedPayloadSchema` |
| `game.<key>.save_completed` | **Save Service**, once 0G Storage confirms the encoded blob is written (not when Redis is) | Verification Service, Analytics | `SaveCompletedPayloadSchema` |
| `game.<key>.save_validated` | **Verification Service** | Analytics, Notification (future) | `SaveValidatedPayloadSchema` |
| `platform.user.login` | Identity Service, on successful login | Analytics | `PlayerLoginPayloadSchema` |
| `platform.user.xp_gained` | **Achievement Service** (fixed amount per achievement unlock — see below) | Profile Service, Reward Service (battle pass), Analytics | `XpGainedPayloadSchema` |
| `platform.profile.updated` | Profile Service, after applying xp/level changes | Analytics | `ProfileUpdatedPayloadSchema` |
| `platform.achievement.unlocked` | Achievement Service | Reward, Notification, Analytics | `AchievementUnlockedPayloadSchema` |
| `platform.reward.granted` | Reward Service | Notification, Analytics | `RewardGrantedPayloadSchema` |
| `platform.leaderboard.updated` | Leaderboard Service | Notification (future), Analytics | — |
| `platform.user.online` / `platform.user.offline` | Reserved — *no live producer yet, needs a presence heartbeat mechanism* | Analytics | `PlayerOnlinePayloadSchema` |

All schemas live in `shared/events/src/schemas.ts` as Zod schemas, exported alongside TypeScript types — producers validate before publish, consumers validate (or at minimum parse) on receipt.

**Why `save_completed` and `game_saved` are published together, by save-service, for the same save:** `SaveCompletedPayloadSchema` is a superset of `GameSavedPayloadSchema` (adds `previousCoinSnapshot`/`previousSaveIndex`, which Verification Service needs to compute a real delta — see below). save-service publishes the *same object* to both subjects: `save_completed` for pipeline-lifecycle consumers, `game_saved` so every Round 1 consumer (Profile, Leaderboard, Achievement, Reward) picks up a managed save with zero code changes. Zod's `.parse()` ignores unrecognized keys by default, so the narrower `GameSavedPayloadSchema` consumers simply don't see the extra fields.

**The XP chain, completed this round:** `platform.user.xp_gained` existed as a schema since Round 1 but had no producer. Now: `achievement-service` publishes it (fixed 50 XP per unlock — a provable rule, not a tuned economy) → `profile-service` is the sole writer of `User.xpTotal`/`level` → `reward-service` independently consumes the same event to advance the platform-wide `BattlePassProgress` tier. This is the full chain the user described: mission/save → achievement → XP → battle pass → reward → profile → analytics → notification (analytics and notification already consume the wildcards from Round 1, so every new event type reaches them automatically).

## Producer / consumer matrix

```
                      Profile  Leaderboard  Achievement  Reward  Analytics  Notification  Verification
game_saved               ✓          ✓            ✓          ✓        ✓
mission_completed                                ✓          ✓        ✓
level_up                                          ✓          ✓        ✓
game_finished                       ✓                                ✓
game_installed                                                        ✓
save_requested                                                        ✓
save_completed                                                        ✓                                ✓
save_validated                                                        ✓             ✓
user.login                                                            ✓
xp_gained                ✓                                  ✓        ✓
profile.updated                                                       ✓
achievement.unlocked                                                  ✓             ✓
reward.granted                                                        ✓             ✓
```

## Today vs. Phase 2 vs. Phase 3 (managed pipeline)

Every `game.*` event for ZeroDash/Warzone still originates from a **Game Adapter** polling the existing public REST endpoints (see [08-migration-roadmap.md](./08-migration-roadmap.md)) — `mission_completed`/`level_up`/`game_finished` are defined in the schema now so achievement/reward/analytics consumers have a stable contract to build against, even though neither adapter emits them yet (ZeroDash and Warzone don't currently expose granular mission/level data on a public endpoint — only aggregate save/leaderboard state). When a game adds the `@platform/event-bridge` SDK (Phase 2), it can start emitting these finer-grained events without any consumer changing. For a game on the **managed save pipeline (Phase 3)**, `save-service` is the live, verified `game_saved`/`save_completed` producer today — confirmed end to end against a real save/load round trip (see `Knowledge_Base.md`), not just specified here.
