import express from "express";
import cors from "cors";
import { PrismaClient } from "@platform/db";
import { createPlatformNatsClient, createRedisClient, createLogger } from "@platform/utils";
import { GAME_EVENTS_STREAM, GAME_EVENT_WILDCARD } from "@platform/events";
import { createStorageDriver } from "@platform/zg-client";
import { requireAuth } from "./auth";
import { createSaveRouter } from "./save.routes";

const logger = createLogger("save-service");
const PORT = Number(process.env.SAVE_SERVICE_PORT || 3008);
const JWT_SECRET = process.env.PLATFORM_JWT_SECRET || "dev-secret-change-me";

async function main() {
  const prisma = new PrismaClient();
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");
  const nats = await createPlatformNatsClient(process.env.NATS_URL || "nats://localhost:4222", [
    { name: GAME_EVENTS_STREAM, subjects: [GAME_EVENT_WILDCARD] },
  ]);
  const storage = createStorageDriver({ logger, localDiskDir: process.env.ZG_LOCAL_STORAGE_DIR || undefined });

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "save-service", storageMode: storage.mode }));

  app.use("/save", requireAuth(JWT_SECRET), createSaveRouter({ prisma, redis, nats, storage }));

  app.listen(PORT, () => logger.info(`save-service listening on :${PORT} (storage mode: ${storage.mode})`));

  process.on("SIGTERM", async () => {
    await nats.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error({ err }, "save-service failed to start");
  process.exit(1);
});
