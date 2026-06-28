import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { PrismaClient, Prisma } from "@platform/db";
import { decodeJson, type PlatformNatsClient } from "@platform/utils";
import { GAME_EVENT_WILDCARD, SaveCompletedPayloadSchema } from "@platform/events";
import { type ComputeClient } from "@platform/zg-client";

const DEFAULT_SYSTEM_PROMPT = `You are an anti-cheat validator for a Unity game save. You receive a JSON object with
saveIndex, prevSaveIndex, coinDelta, timeElapsed (ms), saveData (the full decoded save), and rootHash.
Flag SUSPICIOUS if: coinDelta is implausibly large for the elapsed time, saveIndex did not strictly
increase, or any resource field is negative. Otherwise return CLEAN.
Respond ONLY with JSON: {"verdict":"CLEAN"|"SUSPICIOUS","confidence":0-1,"flags":string[],"rootHash":"<echo the input rootHash exactly>"}`;

/**
 * Reapplies the trigger heuristic from ZeroGCompute.js (coinDelta over a threshold, or
 * saveIndex having advanced at all) but reads the threshold from GameMetadata instead of a
 * hardcoded constant — the concrete example of that extension point. Every save-service
 * save inherently advances saveIndex by exactly 1, so in practice this fires for every
 * managed save, same as both existing repos' nearly-always-true heuristic does today.
 */
async function getCoinDeltaThreshold(prisma: PrismaClient, gameId: string): Promise<number> {
  const row = await prisma.gameMetadata.findUnique({
    where: { gameId_key: { gameId, key: "anti_cheat_coin_delta_threshold" } },
  });
  return typeof row?.value === "number" ? row.value : 0;
}

async function isVerificationEnabled(prisma: PrismaClient, gameId: string): Promise<boolean> {
  const row = await prisma.gameMetadata.findUnique({
    where: { gameId_key: { gameId, key: "verification_enabled" } },
  });
  return row?.value === false ? false : true; // enabled by default unless explicitly disabled
}

export async function startVerificationConsumer(
  nats: PlatformNatsClient,
  prisma: PrismaClient,
  compute: ComputeClient,
  logger: Logger,
) {
  const sub = nats.nc.subscribe(GAME_EVENT_WILDCARD);

  (async () => {
    for await (const msg of sub) {
      try {
        if (!msg.subject.endsWith(".save_completed")) continue;
        const payload = SaveCompletedPayloadSchema.parse(decodeJson<unknown>(msg.data));

        const game = await prisma.game.findUnique({ where: { key: payload.gameKey } });
        if (!game) continue;

        if (!(await isVerificationEnabled(prisma, game.id))) {
          logger.info({ gameKey: payload.gameKey }, "verification disabled for this game via GameMetadata — skipping");
          continue;
        }

        const threshold = await getCoinDeltaThreshold(prisma, game.id);
        const coinDelta = (payload.coinSnapshot ?? 0) - (payload.previousCoinSnapshot ?? 0);
        const saveIndexDelta = payload.saveIndex - (payload.previousSaveIndex ?? -1);
        const shouldVerify = saveIndexDelta >= 1 || coinDelta > threshold;
        if (!shouldVerify) continue;

        const result = await compute.runAntiCheat(
          {
            rootHash: payload.rootHash,
            saveIndex: payload.saveIndex,
            prevSaveIndex: payload.previousSaveIndex ?? -1,
            coinDelta,
            timeElapsedMs: 0,
            saveData: { coinSnapshot: payload.coinSnapshot }, // managed pipeline never re-downloads the full save just to validate
          },
          DEFAULT_SYSTEM_PROMPT,
        );

        const user = await prisma.user.findUnique({ where: { walletAddress: payload.walletAddress } });
        if (user) {
          const progress = await prisma.userGameProgress.findUnique({
            where: { userId_gameId: { userId: user.id, gameId: game.id } },
          });
          if (progress) {
            const prevMetadata = (progress.metadata as Record<string, unknown>) ?? {};
            await prisma.userGameProgress.update({
              where: { userId_gameId: { userId: user.id, gameId: game.id } },
              data: {
                metadata: {
                  ...prevMetadata,
                  computeStatus: result.verdict === "SKIPPED" ? "skipped" : "validated",
                  verdict: result.verdict,
                  confidence: result.confidence,
                  teeVerified: result.teeVerified,
                } satisfies Prisma.InputJsonValue,
              },
            });
          }
        }

        await nats.publishJson(`game.${payload.gameKey}.save_validated`, {
          eventId: randomUUID(),
          occurredAt: new Date().toISOString(),
          gameKey: payload.gameKey,
          walletAddress: payload.walletAddress,
          rootHash: payload.rootHash,
          verdict: result.verdict,
          confidence: result.confidence,
          flags: result.flags,
          teeVerified: result.teeVerified,
        });

        logger.info(
          { wallet: payload.walletAddress, game: payload.gameKey, verdict: result.verdict },
          "save validation complete",
        );
      } catch (err) {
        logger.error({ err }, "failed to process SAVE_COMPLETED for verification");
      }
    }
  })().catch((err) => logger.error({ err }, "verification consumer loop crashed"));
}
