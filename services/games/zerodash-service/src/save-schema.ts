import { z } from "zod";

/**
 * Moved here from shared/dto in Round 4 — see services/games/warzone-service/src/save-schema.ts
 * for the full rationale. Built from TempleEscape/Assets/_TempleEscape/Scripts/Savestate/
 * ZGSaveManager.cs (PlayerSaveData, read-only) + zerodash-0g-backend/src/models/Player.js's
 * matching field names — see docs/game/zerodash.md.
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

/** The only scalar allowed to leave this service's body and land in UserGameProgress.metadata. */
export function extractCoinSnapshot(data: ZeroDashSaveData): number | undefined {
  return data.coins;
}
