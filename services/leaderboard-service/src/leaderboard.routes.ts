import { Router } from "express";
import type { Redis } from "ioredis";
import { RedisKeys } from "@platform/utils";
import type { LeaderboardResponse } from "@platform/dto";

export function createLeaderboardRouter(redis: Redis): Router {
  const router = Router();

  router.get("/:gameKey/:metric", async (req, res) => {
    const { gameKey, metric } = req.params;
    const limit = Math.min(100, Number(req.query.limit) || 50);

    const raw = await redis.zrevrange(RedisKeys.leaderboard(gameKey, metric), 0, limit - 1, "WITHSCORES");

    const entries: LeaderboardResponse["entries"] = [];
    for (let i = 0; i < raw.length; i += 2) {
      entries.push({
        rank: i / 2 + 1,
        walletAddress: raw[i],
        displayName: null,
        score: Number(raw[i + 1]),
      });
    }

    const response: LeaderboardResponse = { gameKey, metric, entries };
    return res.json(response);
  });

  return router;
}
