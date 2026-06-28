import type { Logger } from "pino";
import type { Redis } from "ioredis";
import { PrismaClient } from "@platform/db";
import { decodeJson, getOrCreateUser, RedisKeys, type PlatformNatsClient } from "@platform/utils";
import { GAME_EVENT_WILDCARD, GameSavedPayloadSchema } from "@platform/events";

/**
 * Redis ZADD is the hot read path (sub-millisecond ZREVRANGE for any leaderboard page).
 * The Postgres LeaderboardSnapshot row is the durable copy used for history/audits and to
 * rebuild Redis after a cache flush — never the other way around.
 */
export async function startLeaderboardConsumer(
  nats: PlatformNatsClient,
  redis: Redis,
  prisma: PrismaClient,
  logger: Logger,
) {
  const sub = nats.nc.subscribe(GAME_EVENT_WILDCARD);

  (async () => {
    for await (const msg of sub) {
      try {
        if (!msg.subject.endsWith(".game_saved")) continue;
        const payload = GameSavedPayloadSchema.parse(decodeJson<unknown>(msg.data));
        if (payload.coinSnapshot === undefined) continue;

        await redis.zadd(
          RedisKeys.leaderboard(payload.gameKey, "coinSnapshot"),
          payload.coinSnapshot,
          payload.walletAddress,
        );

        const user = await getOrCreateUser(prisma, payload.walletAddress);
        const game = await prisma.game.findUnique({ where: { key: payload.gameKey } });
        if (game) {
          await prisma.leaderboardSnapshot.create({
            data: {
              gameId: game.id,
              userId: user.id,
              metric: "coinSnapshot",
              score: BigInt(Math.trunc(payload.coinSnapshot)),
            },
          });
        }
      } catch (err) {
        logger.error({ err }, "failed to process leaderboard event");
      }
    }
  })().catch((err) => logger.error({ err }, "leaderboard consumer loop crashed"));
}
