import express from "express";
import cors from "cors";
import { PrismaClient } from "@platform/db";
import { createPlatformNatsClient, createRedisClient, createLogger } from "@platform/utils";
import { GAME_EVENTS_STREAM, GAME_EVENT_WILDCARD } from "@platform/events";
import { createLeaderboardRouter } from "./leaderboard.routes";
import { startLeaderboardConsumer } from "./leaderboard.consumer";

const logger = createLogger("leaderboard-service");
const PORT = Number(process.env.LEADERBOARD_SERVICE_PORT || 3003);

async function main() {
  const prisma = new PrismaClient();
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");
  const nats = await createPlatformNatsClient(process.env.NATS_URL || "nats://localhost:4222", [
    { name: GAME_EVENTS_STREAM, subjects: [GAME_EVENT_WILDCARD] },
  ]);

  await startLeaderboardConsumer(nats, redis, prisma, logger);

  const app = express();
  app.use(cors());
  app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "leaderboard-service" }));
  app.use("/leaderboard", createLeaderboardRouter(redis));

  app.listen(PORT, () => logger.info(`leaderboard-service listening on :${PORT}`));
}

main().catch((err) => {
  logger.error({ err }, "leaderboard-service failed to start");
  process.exit(1);
});
