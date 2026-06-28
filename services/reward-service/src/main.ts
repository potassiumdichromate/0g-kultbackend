import express from "express";
import cors from "cors";
import { PrismaClient } from "@platform/db";
import { createPlatformNatsClient, createLogger } from "@platform/utils";
import { GAME_EVENTS_STREAM, GAME_EVENT_WILDCARD, PLATFORM_EVENTS_STREAM, PLATFORM_EVENT_WILDCARD } from "@platform/events";
import { ensureSeedRewards, startRewardConsumer } from "./reward.consumer";
import { startBattlePassConsumer } from "./battlepass.consumer";

const logger = createLogger("reward-service");
const PORT = Number(process.env.REWARD_SERVICE_PORT || 3005);

async function main() {
  const prisma = new PrismaClient();
  await ensureSeedRewards(prisma);

  const nats = await createPlatformNatsClient(process.env.NATS_URL || "nats://localhost:4222", [
    { name: GAME_EVENTS_STREAM, subjects: [GAME_EVENT_WILDCARD] },
    { name: PLATFORM_EVENTS_STREAM, subjects: [PLATFORM_EVENT_WILDCARD] },
  ]);

  await startRewardConsumer(nats, prisma, logger);
  await startBattlePassConsumer(nats, prisma, logger);

  const app = express();
  app.use(cors());
  app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "reward-service" }));
  app.get("/rewards/:wallet", async (req, res) => {
    const wallet = req.params.wallet.toLowerCase();
    const user = await prisma.user.findUnique({ where: { walletAddress: wallet } });
    if (!user) return res.json({ rewards: [] });
    const rewards = await prisma.userReward.findMany({
      where: { userId: user.id },
      include: { reward: true, sourceGame: true },
    });
    res.json({ rewards });
  });
  app.get("/battle-pass/:wallet", async (req, res) => {
    const wallet = req.params.wallet.toLowerCase();
    const user = await prisma.user.findUnique({ where: { walletAddress: wallet } });
    if (!user) return res.json({ progress: null });
    const progress = await prisma.battlePassProgress.findFirst({
      where: { userId: user.id, gameId: null, seasonKey: "season_1" },
    });
    res.json({ progress });
  });

  app.listen(PORT, () => logger.info(`reward-service listening on :${PORT}`));
}

main().catch((err) => {
  logger.error({ err }, "reward-service failed to start");
  process.exit(1);
});
