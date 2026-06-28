import { Router } from "express";
import { PrismaClient } from "@platform/db";
import type { UnifiedProfileResponse } from "@platform/dto";

export function createProfileRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/:wallet", async (req, res) => {
    const wallet = req.params.wallet.toLowerCase();

    const user = await prisma.user.findUnique({
      where: { walletAddress: wallet },
      include: {
        gameProgress: { include: { game: true } },
        achievements: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: "No platform profile for this wallet yet" });
    }

    const response: UnifiedProfileResponse = {
      walletAddress: user.walletAddress,
      displayName: user.displayName,
      xpTotal: user.xpTotal,
      level: user.level,
      achievementCount: user.achievements.length,
      games: user.gameProgress.map((p) => ({
        gameKey: p.game.key,
        rootHash: p.rootHash,
        saveIndex: p.saveIndex,
        lastSaveTime: p.lastSaveTime.toISOString(),
        metadata: p.metadata as Record<string, unknown>,
      })),
    };

    return res.json(response);
  });

  return router;
}
