import express from "express";
import cors from "cors";
import { PrismaClient } from "@platform/db";
import { createPlatformNatsClient, createLogger } from "@platform/utils";
import { GAME_EVENTS_STREAM, GAME_EVENT_WILDCARD, PLATFORM_EVENTS_STREAM, PLATFORM_EVENT_WILDCARD } from "@platform/events";
import { ensureSeedAchievements, startAchievementConsumer } from "./achievement.consumer";

const logger = createLogger("achievement-service");
const PORT = Number(process.env.ACHIEVEMENT_SERVICE_PORT || 3004);

async function main() {
  const prisma = new PrismaClient();
  await ensureSeedAchievements(prisma);

  const nats = await createPlatformNatsClient(process.env.NATS_URL || "nats://localhost:4222", [
    { name: GAME_EVENTS_STREAM, subjects: [GAME_EVENT_WILDCARD] },
    { name: PLATFORM_EVENTS_STREAM, subjects: [PLATFORM_EVENT_WILDCARD] },
  ]);

  await startAchievementConsumer(nats, prisma, logger);

  const app = express();
  app.use(cors());
  app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "achievement-service" }));
  app.get("/achievements", async (_req, res) => {
    const achievements = await prisma.achievement.findMany();
    res.json({ achievements });
  });

  app.listen(PORT, () => logger.info(`achievement-service listening on :${PORT}`));
}

main().catch((err) => {
  logger.error({ err }, "achievement-service failed to start");
  process.exit(1);
});
