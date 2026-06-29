import express from "express";
import cors from "cors";
import { PrismaClient } from "@platform/db";
import { createPlatformNatsClient, createLogger } from "@platform/utils";
import { GAME_EVENTS_STREAM, GAME_EVENT_WILDCARD } from "@platform/events";
import { createComputeClient } from "@platform/zg-client";
import { requireAuth } from "./auth";
import { createSaveRouter } from "./save.routes";
import { createMissionRouter } from "./mission.routes";

const logger = createLogger("warzone-service");
const PORT = Number(process.env.WARZONE_SERVICE_PORT || 3010);
const JWT_SECRET = process.env.PLATFORM_JWT_SECRET || "dev-secret-change-me";
const SAVE_SERVICE_URL = process.env.SAVE_SERVICE_URL || "http://localhost:3008";

const GAME_KEY = "warzone";
const FIRST_BLOOD_ACHIEVEMENT_KEY = "warzone_first_blood";

/** This per-game service owns seeding its own gameplay-specific achievements — see vision doc. */
async function ensureSeedAchievement(prisma: PrismaClient) {
  const game = await prisma.game.findUnique({ where: { key: GAME_KEY } });
  if (!game) {
    logger.warn(`Game row "${GAME_KEY}" not found — run shared/db/seed.js first. Skipping achievement seed.`);
    return;
  }
  const criteria = { type: "first_event" as const, eventType: "mission_completed", gameKey: GAME_KEY };
  await prisma.achievement.upsert({
    where: { key: FIRST_BLOOD_ACHIEVEMENT_KEY },
    update: { criteria },
    create: {
      key: FIRST_BLOOD_ACHIEVEMENT_KEY,
      name: "First Blood",
      description: "Complete your first mission in Warzone Warriors.",
      gameId: game.id,
      criteria,
    },
  });
}

async function main() {
  const prisma = new PrismaClient();
  await ensureSeedAchievement(prisma);

  const nats = await createPlatformNatsClient(process.env.NATS_URL || "nats://localhost:4222", [
    { name: GAME_EVENTS_STREAM, subjects: [GAME_EVENT_WILDCARD] },
  ]);
  const compute = createComputeClient({ logger });

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", (_req, res) =>
    res.json({ status: "ok", service: "warzone-service", computeConfigured: compute.isConfigured }),
  );

  app.use("/save", requireAuth(JWT_SECRET), createSaveRouter(SAVE_SERVICE_URL));
  app.use("/mission-completed", requireAuth(JWT_SECRET), createMissionRouter({ nats, compute, logger }));

  app.listen(PORT, () => logger.info(`warzone-service listening on :${PORT}`));

  process.on("SIGTERM", async () => {
    await nats.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error({ err }, "warzone-service failed to start");
  process.exit(1);
});
