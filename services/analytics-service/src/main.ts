import express from "express";
import cors from "cors";
import { PrismaClient } from "@platform/db";
import { createPlatformNatsClient, createLogger } from "@platform/utils";
import { GAME_EVENTS_STREAM, GAME_EVENT_WILDCARD, PLATFORM_EVENTS_STREAM, PLATFORM_EVENT_WILDCARD } from "@platform/events";
import { startAnalyticsConsumer } from "./analytics.consumer";

const logger = createLogger("analytics-service");
const PORT = Number(process.env.ANALYTICS_SERVICE_PORT || 3006);

async function main() {
  const prisma = new PrismaClient();
  const nats = await createPlatformNatsClient(process.env.NATS_URL || "nats://localhost:4222", [
    { name: GAME_EVENTS_STREAM, subjects: [GAME_EVENT_WILDCARD] },
    { name: PLATFORM_EVENTS_STREAM, subjects: [PLATFORM_EVENT_WILDCARD] },
  ]);

  await startAnalyticsConsumer(nats, prisma, logger);

  const app = express();
  app.use(cors());
  app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "analytics-service" }));
  app.get("/events/recent", async (_req, res) => {
    const events = await prisma.rawEvent.findMany({ orderBy: { occurredAt: "desc" }, take: 50 });
    res.json({ events });
  });

  app.listen(PORT, () => logger.info(`analytics-service listening on :${PORT}`));
}

main().catch((err) => {
  logger.error({ err }, "analytics-service failed to start");
  process.exit(1);
});
