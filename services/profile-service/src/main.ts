import express from "express";
import cors from "cors";
import { PrismaClient } from "@platform/db";
import { createPlatformNatsClient, createLogger } from "@platform/utils";
import { GAME_EVENTS_STREAM, GAME_EVENT_WILDCARD, PLATFORM_EVENTS_STREAM, PLATFORM_EVENT_WILDCARD } from "@platform/events";
import { createProfileRouter } from "./profile.routes";
import { startGameSavedConsumer } from "./game-saved.consumer";
import { startXpConsumer } from "./xp.consumer";

const logger = createLogger("profile-service");
const PORT = Number(process.env.PROFILE_SERVICE_PORT || 3002);

async function main() {
  const prisma = new PrismaClient();
  const nats = await createPlatformNatsClient(process.env.NATS_URL || "nats://localhost:4222", [
    { name: GAME_EVENTS_STREAM, subjects: [GAME_EVENT_WILDCARD] },
    { name: PLATFORM_EVENTS_STREAM, subjects: [PLATFORM_EVENT_WILDCARD] },
  ]);

  await startGameSavedConsumer(nats, prisma, logger);
  await startXpConsumer(nats, prisma, logger);

  const app = express();
  app.use(cors());
  app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "profile-service" }));
  app.use("/profile", createProfileRouter(prisma));

  app.listen(PORT, () => logger.info(`profile-service listening on :${PORT}`));

  process.on("SIGTERM", async () => {
    await nats.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error({ err }, "profile-service failed to start");
  process.exit(1);
});
