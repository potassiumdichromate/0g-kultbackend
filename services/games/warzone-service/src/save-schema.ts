import { z } from "zod";

/**
 * Moved here from shared/dto in Round 4 — a game's save shape is the one thing that's
 * inherently game-specific, so it's owned by that game's own service, not a shared static
 * file every new game would otherwise have to edit. Built from the real Unity client source
 * (Metal Black OPS/Assets/_Assets/Web3Integ/ZGSaveManager.cs, read-only) and
 * warzone-backend-0g/src/models/PlayerProfile.js's matching field names — see
 * docs/game/warzonewarriors.md.
 */
const RamboSchema = z.object({ id: z.number().int(), level: z.number().int() });
const GunSchema = z.object({
  id: z.number().int(),
  level: z.number().int(),
  ammo: z.number().int(),
  isNew: z.boolean(),
});
const GrenadeSchema = z.object({
  id: z.number().int(),
  level: z.number().int(),
  quantity: z.number().int(),
  isNew: z.boolean(),
});
const MeleeSchema = z.object({ id: z.number().int(), level: z.number().int(), isNew: z.boolean() });
const DailyQuestSchema = z.object({
  type: z.number().int(),
  progress: z.number().int(),
  isClaimed: z.boolean(),
});
const AchievementSchema = z.object({
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
  PlayerRambos: z.record(RamboSchema).default({}),
  PlayerRamboSkills: z.record(z.record(z.number())).default({}),
  PlayerGuns: z.record(GunSchema).default({}),
  PlayerGrenades: z.record(GrenadeSchema).default({}),
  PlayerMeleeWeapons: z.record(MeleeSchema).default({}),
  PlayerCampaignProgress: z.record(z.unknown()).default({}),
  PlayerCampaignStageProgress: z.record(z.array(z.boolean()).length(3)).default({}),
  PlayerCampaignRewardProgress: z.record(z.array(z.boolean())).default({}),
  PlayerBoosters: z.record(z.number()).default({}),
  PlayerSelectingBooster: z.array(z.number()).default([]),
  PlayerDailyQuestData: z.array(DailyQuestSchema).default([]),
  PlayerAchievementData: z.record(AchievementSchema).default({}),
  PlayerTutorialData: z.record(z.boolean()).default({}),
});
export type WarzoneSaveData = z.infer<typeof WarzoneSaveDataSchema>;

/** The only scalar allowed to leave this service's body and land in UserGameProgress.metadata. */
export function extractCoinSnapshot(data: WarzoneSaveData): number | undefined {
  return data.PlayerResources?.coin;
}
