import type { Logger } from "pino";
import { PrismaClient } from "@platform/db";
import { decodeJson, getOrCreateUser, type PlatformNatsClient } from "@platform/utils";
import { GAME_EVENT_WILDCARD, GameSavedPayloadSchema } from "@platform/events";

/**
 * Upserts User + UserGameProgress on every GAME_SAVED event. This is the literal
 * implementation of "rootHash becomes metadata inside UserGameProgress" — the actual save
 * file is never touched here, only the pointer to it in 0G Storage plus pipeline status.
 */
export async function startGameSavedConsumer(nats: PlatformNatsClient, prisma: PrismaClient, logger: Logger) {
  const sub = nats.nc.subscribe(GAME_EVENT_WILDCARD);

  (async () => {
    for await (const msg of sub) {
      try {
        const raw = decodeJson<unknown>(msg.data);
        const subjectParts = msg.subject.split("."); // game.<gameKey>.<event>
        const eventName = subjectParts[2];
        if (eventName !== "game_saved") continue;

        const payload = GameSavedPayloadSchema.parse(raw);

        const user = await getOrCreateUser(prisma, payload.walletAddress);

        const game = await prisma.game.findUnique({ where: { key: payload.gameKey } });
        if (!game) {
          logger.warn({ gameKey: payload.gameKey }, "GAME_SAVED for unregistered game — skipping");
          continue;
        }

        // GAME_SAVED and SAVE_COMPLETED are published from the same snapshot, before
        // verification-service has had a chance to run — payload.computeStatus is always
        // "pending" here. A blind metadata replace would race with verification-service's
        // later update and clobber its verdict back to "pending" (caught live during Round 4
        // testing, not theoretical — see Knowledge_Base.md). Merge instead: this event owns
        // checksum/daStatus/coinSnapshot; computeStatus/verdict/teeVerified are
        // verification-service's exclusively, so only seed them here if nothing has set them yet.
        const existing = await prisma.userGameProgress.findUnique({
          where: { userId_gameId: { userId: user.id, gameId: game.id } },
        });
        const prevMetadata = (existing?.metadata as Record<string, unknown> | undefined) ?? {};

        await prisma.userGameProgress.upsert({
          where: { userId_gameId: { userId: user.id, gameId: game.id } },
          update: {
            rootHash: payload.rootHash,
            saveIndex: payload.saveIndex,
            lastSaveTime: new Date(payload.occurredAt),
            metadata: {
              ...prevMetadata,
              checksum: payload.checksum,
              daStatus: payload.daStatus,
              coinSnapshot: payload.coinSnapshot,
              computeStatus: prevMetadata.computeStatus ?? payload.computeStatus,
            },
          },
          create: {
            userId: user.id,
            gameId: game.id,
            rootHash: payload.rootHash,
            saveIndex: payload.saveIndex,
            lastSaveTime: new Date(payload.occurredAt),
            metadata: {
              checksum: payload.checksum,
              daStatus: payload.daStatus,
              computeStatus: payload.computeStatus,
              coinSnapshot: payload.coinSnapshot,
            },
          },
        });

        logger.info({ wallet: payload.walletAddress, game: payload.gameKey }, "UserGameProgress updated");
      } catch (err) {
        logger.error({ err }, "failed to process GAME_SAVED message");
      }
    }
  })().catch((err) => logger.error({ err }, "game-saved consumer loop crashed"));
}
