import express from "express";
import { createPlatformNatsClient, createRedisClient, createLogger, startGameSaveAdapter } from "@platform/utils";
import { GAME_EVENTS_STREAM } from "@platform/events";

const logger = createLogger("warzone-adapter");
const GAME_KEY = "warzone";
const PORT = Number(process.env.WARZONE_ADAPTER_PORT || 3102);

async function main() {
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");
  const nats = await createPlatformNatsClient(process.env.NATS_URL || "nats://localhost:4222", [
    { name: GAME_EVENTS_STREAM, subjects: [`game.${GAME_KEY}.*`] },
  ]);

  const adapter = startGameSaveAdapter({
    gameKey: GAME_KEY,
    backendBaseUrl: process.env.WARZONE_BACKEND_URL || "https://warzone-backend-0g.onrender.com",
    pollIntervalMs: Number(process.env.ADAPTER_POLL_INTERVAL_MS || 15000),
    redis,
    nats,
    logger,
  });

  const app = express();
  app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "warzone-adapter" }));
  app.listen(PORT, () => logger.info(`warzone-adapter listening on :${PORT}`));

  process.on("SIGTERM", () => {
    adapter.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error({ err }, "warzone-adapter failed to start");
  process.exit(1);
});
