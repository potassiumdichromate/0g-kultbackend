import express from "express";
import { PrismaClient } from "@platform/db";
import { createPlatformNatsClient, createLogger } from "@platform/utils";
import { GAME_EVENTS_STREAM, GAME_EVENT_WILDCARD } from "@platform/events";
import { createComputeClient } from "@platform/zg-client";
import { startVerificationConsumer } from "./verification.consumer";

const logger = createLogger("verification-service");
const PORT = Number(process.env.VERIFICATION_SERVICE_PORT || 3009);

async function main() {
  const prisma = new PrismaClient();
  const nats = await createPlatformNatsClient(process.env.NATS_URL || "nats://localhost:4222", [
    { name: GAME_EVENTS_STREAM, subjects: [GAME_EVENT_WILDCARD] },
  ]);
  const compute = createComputeClient({ logger });

  await startVerificationConsumer(nats, prisma, compute, logger);

  const app = express();
  app.get("/healthz", (_req, res) =>
    res.json({ status: "ok", service: "verification-service", computeConfigured: compute.isConfigured }),
  );
  app.listen(PORT, () =>
    logger.info(`verification-service listening on :${PORT} (0G Compute configured: ${compute.isConfigured})`),
  );
}

main().catch((err) => {
  logger.error({ err }, "verification-service failed to start");
  process.exit(1);
});
