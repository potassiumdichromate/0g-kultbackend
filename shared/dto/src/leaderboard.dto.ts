import { z } from "zod";

export const LeaderboardEntryDto = z.object({
  rank: z.number(),
  walletAddress: z.string(),
  displayName: z.string().nullable(),
  score: z.number(),
});

export const LeaderboardResponseSchema = z.object({
  gameKey: z.string().nullable(), // null = global cross-game leaderboard
  metric: z.string(),
  entries: z.array(LeaderboardEntryDto),
});

export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>;
