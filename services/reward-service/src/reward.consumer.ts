import type { Logger } from "pino";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@platform/db";
import { decodeJson, getOrCreateUser, type PlatformNatsClient } from "@platform/utils";
import { GAME_EVENT_WILDCARD, GameSavedPayloadSchema, PLATFORM_SUBJECTS } from "@platform/events";

/**
 * Direct replacement for zerodash-0g-backend/src/services/warzoneGunRewardClient.js, which
 * hardcoded Warzone's URL and a shared secret string to grant a shotgun unlock once a
 * player's ZeroDash coin balance crossed the "medium" difficulty threshold (>= 8, see
 * crossGameDifficulty.js). The threshold logic is the same; the delivery mechanism is now
 * a NATS event instead of ZeroDash calling Warzone's API directly — ZeroDash never needs to
 * know Warzone exists, and a 3rd, 4th, 100th game can react to the same reward the same way.
 */
const CROSS_GAME_REWARD_KEY = "cross_game_warzone_shotgun";
const COIN_THRESHOLD = 8;

export async function ensureSeedRewards(prisma: PrismaClient) {
  await prisma.reward.upsert({
    where: { key: CROSS_GAME_REWARD_KEY },
    update: {},
    create: {
      key: CROSS_GAME_REWARD_KEY,
      type: "cross_game_unlock",
      payload: { targetGame: "warzone", item: "shotgun" },
    },
  });
}

export async function startRewardConsumer(nats: PlatformNatsClient, prisma: PrismaClient, logger: Logger) {
  const sub = nats.nc.subscribe(GAME_EVENT_WILDCARD);

  (async () => {
    for await (const msg of sub) {
      try {
        if (!msg.subject.startsWith("game.zerodash.") || !msg.subject.endsWith(".game_saved")) continue;
        const payload = GameSavedPayloadSchema.parse(decodeJson<unknown>(msg.data));
        if (payload.coinSnapshot === undefined || payload.coinSnapshot < COIN_THRESHOLD) continue;

        const user = await getOrCreateUser(prisma, payload.walletAddress);

        const reward = await prisma.reward.findUnique({ where: { key: CROSS_GAME_REWARD_KEY } });
        if (!reward) continue;

        const sourceGame = await prisma.game.findUnique({ where: { key: "zerodash" } });

        const existing = await prisma.userReward.findFirst({
          where: { userId: user.id, rewardId: reward.id },
        });
        if (existing) continue;

        await prisma.userReward.create({
          data: {
            userId: user.id,
            rewardId: reward.id,
            sourceGameId: sourceGame?.id,
            status: "GRANTED",
          },
        });

        await nats.publishJson(PLATFORM_SUBJECTS.rewardGranted, {
          eventId: randomUUID(),
          occurredAt: new Date().toISOString(),
          walletAddress: payload.walletAddress,
          rewardKey: reward.key,
          sourceGameKey: "zerodash",
          targetGameKey: "warzone",
        });

        logger.info({ wallet: payload.walletAddress, reward: reward.key }, "cross-game reward granted");
      } catch (err) {
        logger.error({ err }, "failed to process reward event");
      }
    }
  })().catch((err) => logger.error({ err }, "reward consumer loop crashed"));
}
