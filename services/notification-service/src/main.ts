import express from "express";
import { decodeJson, createPlatformNatsClient, createLogger } from "@platform/utils";
import { PLATFORM_EVENTS_STREAM, PLATFORM_EVENT_WILDCARD, PLATFORM_SUBJECTS } from "@platform/events";

const logger = createLogger("notification-service");
const PORT = Number(process.env.NOTIFICATION_SERVICE_PORT || 3007);

/**
 * Stub fan-out: today this just logs a structured "would have notified" entry. Swapping in
 * a real push/email/in-app provider only touches this file — producers (achievement-service,
 * reward-service) never need to know notification-service exists, let alone how it delivers.
 */
async function main() {
  const nats = await createPlatformNatsClient(process.env.NATS_URL || "nats://localhost:4222", [
    { name: PLATFORM_EVENTS_STREAM, subjects: [PLATFORM_EVENT_WILDCARD] },
  ]);

  const sub = nats.nc.subscribe(PLATFORM_EVENT_WILDCARD);
  (async () => {
    for await (const msg of sub) {
      if (msg.subject === PLATFORM_SUBJECTS.achievementUnlocked) {
        const payload = decodeJson(msg.data);
        logger.info({ payload }, "NOTIFY: achievement unlocked");
      } else if (msg.subject === PLATFORM_SUBJECTS.rewardGranted) {
        const payload = decodeJson(msg.data);
        logger.info({ payload }, "NOTIFY: reward granted");
      }
    }
  })().catch((err) => logger.error({ err }, "notification consumer loop crashed"));

  const app = express();
  app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "notification-service" }));
  app.listen(PORT, () => logger.info(`notification-service listening on :${PORT}`));
}

main().catch((err) => {
  logger.error({ err }, "notification-service failed to start");
  process.exit(1);
});
