import { z } from "zod";

/**
 * Real, per-game save payload shapes — not a generic JSON blob. Built directly from the
 * actual Unity client source (read-only exploration, not modified):
 *   ZeroDash: Assets/_TempleEscape/Scripts/Savestate/ZGSaveManager.cs (PlayerSaveData) +
 *             zerodash-0g-backend/src/models/Player.js (matching Mongoose field names)
 *   Warzone:  Assets/_Assets/Web3Integ/ZGSaveManager.cs (the JObject it builds before WZSV
 *             encoding) + warzone-backend-0g/src/models/PlayerProfile.js (identical field
 *             names — Intraverse, PlayerProfile, PlayerResources, PlayerRambos, PlayerGuns,
 *             PlayerGrenades, PlayerMeleeWeapons, PlayerCampaignStageProgress,
 *             PlayerCampaignRewardProgress, PlayerBoosters, PlayerDailyQuestData,
 *             PlayerAchievementData, PlayerTutorialData).
 *
 * save-service validates every incoming save against the schema for its gameKey before
 * encoding/uploading anything — malformed or tampered payloads are rejected by shape, not
 * silently encoded and charged a 0G Storage write.
 */

export const ZeroDashSaveDataSchema = z.object({
  coins: z.number().int().nonnegative(),
  highScore: z.number().int().nonnegative(),
  nftPass: z.boolean(),
  characters: z.object({
    unlocked: z.array(z.string()).default([]),
    currentIndex: z.number().int().nonnegative().default(0),
  }),
  dailyReward: z.object({
    nextRewardAt: z.number().int().nonnegative(), // unix seconds — matches Unity's NextDailyRewardTimestamp
  }),
});
export type ZeroDashSaveData = z.infer<typeof ZeroDashSaveDataSchema>;

const WarzoneRamboSchema = z.object({ id: z.number().int(), level: z.number().int() });
const WarzoneGunSchema = z.object({
  id: z.number().int(),
  level: z.number().int(),
  ammo: z.number().int(),
  isNew: z.boolean(),
});
const WarzoneGrenadeSchema = z.object({
  id: z.number().int(),
  level: z.number().int(),
  quantity: z.number().int(),
  isNew: z.boolean(),
});
const WarzoneMeleeSchema = z.object({ id: z.number().int(), level: z.number().int(), isNew: z.boolean() });
const WarzoneDailyQuestSchema = z.object({
  type: z.number().int(),
  progress: z.number().int(),
  isClaimed: z.boolean(),
});
const WarzoneAchievementSchema = z.object({
  type: z.number().int(),
  progress: z.number().int(),
  claimTimes: z.number().int(),
});

export const WarzoneSaveDataSchema = z.object({
  Intraverse: z.object({ userId: z.string().default(""), userName: z.string().default("") }).default({}),
  PlayerProfile: z.object({
    level: z.number().int().positive(),
    exp: z.number().int().nonnegative(),
    totalTimePlayed: z.number().int().nonnegative().default(0),
  }),
  PlayerResources: z.object({
    coin: z.number().int().nonnegative(),
    gem: z.number().int().nonnegative(),
    stamina: z.number().int().nonnegative(),
    medal: z.number().int().nonnegative(),
    tournamentTicket: z.number().int().nonnegative(),
  }),
  PlayerRambos: z.record(WarzoneRamboSchema).default({}),
  PlayerRamboSkills: z.record(z.record(z.number())).default({}),
  PlayerGuns: z.record(WarzoneGunSchema).default({}),
  PlayerGrenades: z.record(WarzoneGrenadeSchema).default({}),
  PlayerMeleeWeapons: z.record(WarzoneMeleeSchema).default({}),
  PlayerCampaignProgress: z.record(z.unknown()).default({}),
  PlayerCampaignStageProgress: z.record(z.array(z.boolean()).length(3)).default({}),
  PlayerCampaignRewardProgress: z.record(z.array(z.boolean())).default({}),
  PlayerBoosters: z.record(z.number()).default({}),
  PlayerSelectingBooster: z.array(z.number()).default([]),
  PlayerDailyQuestData: z.array(WarzoneDailyQuestSchema).default([]),
  PlayerAchievementData: z.record(WarzoneAchievementSchema).default({}),
  PlayerTutorialData: z.record(z.boolean()).default({}),
});
export type WarzoneSaveData = z.infer<typeof WarzoneSaveDataSchema>;

/** save-service looks up both the validator and the leaderboard-index extractor by gameKey. */
export const SAVE_DATA_SCHEMAS: Record<string, z.ZodTypeAny> = {
  zerodash: ZeroDashSaveDataSchema,
  warzone: WarzoneSaveDataSchema,
};

/**
 * The only scalars allowed to leave save-service's JSON body and land in
 * UserGameProgress.metadata (never the full payload) — see the Postgres ground rule in
 * architecture/03-database-diagram.md.
 */
export const extractCoinSnapshot: Record<string, (data: unknown) => number | undefined> = {
  zerodash: (data) => (data as ZeroDashSaveData).coins,
  warzone: (data) => (data as WarzoneSaveData).PlayerResources?.coin,
};
