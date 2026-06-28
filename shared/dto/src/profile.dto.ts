import { z } from "zod";

export const GameProgressDto = z.object({
  gameKey: z.string(),
  rootHash: z.string(),
  saveIndex: z.number(),
  lastSaveTime: z.string(),
  metadata: z.record(z.unknown()),
});

export const UnifiedProfileResponseSchema = z.object({
  walletAddress: z.string(),
  displayName: z.string().nullable(),
  xpTotal: z.number(),
  level: z.number(),
  games: z.array(GameProgressDto),
  achievementCount: z.number(),
});

export type UnifiedProfileResponse = z.infer<typeof UnifiedProfileResponseSchema>;
