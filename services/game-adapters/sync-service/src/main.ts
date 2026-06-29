import express from "express";
import { PrismaClient } from "@platform/db";
import { createPlatformNatsClient, createRedisClient, createLogger, startGameSaveAdapter } from "@platform/utils";
import { GAME_EVENTS_STREAM, GAME_EVENT_WILDCARD } from "@platform/events";

const logger = createLogger("sync-service");
const PORT = Number(process.env.SYNC_SERVICE_PORT || 3101);
const POLL_INTERVAL_MS = Number(process.env.ADAPTER_POLL_INTERVAL_MS || 15000);
const REFRESH_INTERVAL_MS = Number(process.env.SYNC_SERVICE_REFRESH_INTERVAL_MS || 60000);

/**
 * Round 3: this single service replaces zerodash-adapter and warzone-adapter, which were
 * two near-identical copies of the same logic differing only in GAME_KEY and a backend URL
 * — exactly the kind of duplication architecture/00-platform-vision.md flags. Adding game
 * #3 to the zero-touch bridge, or retiring a game's bridge once it migrates onto
 * save-service, is now a `Game.integrationMode` database update picked up on the next
 * refresh cycle — never a new service or a deploy.
 */
async function main() {
  const prisma = new PrismaClient();
  const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");
  const nats = await createPlatformNatsClient(process.env.NATS_URL || "nats://localhost:4222", [
    { name: GAME_EVENTS_STREAM, subjects: [GAME_EVENT_WILDCARD] },
  ]);

  const active = new Map<string, { stop: () => void; backendBaseUrl: string }>();

  async function refresh() {
    const games = await prisma.game.findMany({
      where: { integrationMode: "POLLING_ADAPTER", status: "ACTIVE" },
    });
    const desiredKeys = new Set(games.map((g) => g.key));

    // Stop adapters for games that were removed, retired, or migrated off POLLING_ADAPTER.
    for (const [gameKey, entry] of active) {
      if (!desiredKeys.has(gameKey)) {
        entry.stop();
        active.delete(gameKey);
        logger.info({ gameKey }, "stopped polling adapter (game no longer POLLING_ADAPTER/ACTIVE)");
      }
    }

    // Start adapters for new games, or restart ones whose backend URL changed.
    for (const game of games) {
      const existing = active.get(game.key);
      if (existing && existing.backendBaseUrl === game.backendBaseUrl) continue;
      if (existing) {
        existing.stop();
        active.delete(game.key);
      }

      const adapter = startGameSaveAdapter({
        gameKey: game.key,
        backendBaseUrl: game.backendBaseUrl,
        pollIntervalMs: POLL_INTERVAL_MS,
        redis,
        nats,
        logger,
      });
      active.set(game.key, { stop: adapter.stop, backendBaseUrl: game.backendBaseUrl });
      logger.info({ gameKey: game.key, backendBaseUrl: game.backendBaseUrl }, "started polling adapter");
    }
  }

  await refresh();
  const refreshTimer = setInterval(() => {
    refresh().catch((err) => logger.error({ err }, "adapter refresh cycle failed"));
  }, REFRESH_INTERVAL_MS);

  const app = express();
  app.get("/healthz", (_req, res) =>
    res.json({ status: "ok", service: "sync-service", syncing: Array.from(active.keys()) }),
  );
  app.listen(PORT, () => logger.info(`sync-service listening on :${PORT}`));

  process.on("SIGTERM", async () => {
    clearInterval(refreshTimer);
    for (const entry of active.values()) entry.stop();
    await nats.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error({ err }, "sync-service failed to start");
  process.exit(1);
});
