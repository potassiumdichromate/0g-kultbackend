import type { Logger } from "pino";
import { randomUUID } from "node:crypto";
import { PrismaClient, Prisma } from "@platform/db";
import {
  decodeJson,
  getOrCreateUser,
  matchesEventCriteria,
  type CriteriaContext,
  type PlatformNatsClient,
} from "@platform/utils";
import { GAME_EVENT_WILDCARD, EventEnvelopeSchema, PLATFORM_SUBJECTS } from "@platform/events";

/**
 * Direct replacement for zerodash-0g-backend/src/services/warzoneGunRewardClient.js, which
 * hardcoded Warzone's URL and a shared secret string to grant a shotgun unlock once a
 * player's ZeroDash coin balance crossed the "medium" difficulty threshold (>= 8, see
 * crossGameDifficulty.js). The threshold now lives on the Reward row's `criteria` column
 * (EventCriteria, shared/utils/src/criteria.ts) instead of a hardcoded constant — adding
 * reward #2 is a database row, not a code change. The delivery mechanism is a NATS event
 * instead of ZeroDash calling Warzone's API directly — ZeroDash never needs to know Warzone
 * exists, and a 3rd, 4th, 100th game can react to the same reward the same way.
 */
const CROSS_GAME_REWARD_KEY = "cross_game_warzone_shotgun";

const CROSS_GAME_REWARD_CRITERIA = {
  type: "threshold" as const,
  eventType: "game_saved",
  gameKey: "zerodash",
  field: "coinSnapshot",
  op: ">=" as const,
  value: 8,
};

export async function ensureSeedRewards(prisma: PrismaClient) {
  // `update` deliberately re-applies criteria/payload on every startup, not just `{}` —
  // an upsert that only sets fields on `create` never backfills a row that already existed
  // before that field was added. Caught live: a Round-2-seeded row had a NULL `criteria`
  // until this fix, silently breaking the generic rule evaluator for an existing reward.
  await prisma.reward.upsert({
    where: { key: CROSS_GAME_REWARD_KEY },
    update: { criteria: CROSS_GAME_REWARD_CRITERIA, payload: { targetGame: "warzone", item: "shotgun" } },
    create: {
      key: CROSS_GAME_REWARD_KEY,
      type: "cross_game_unlock",
      payload: { targetGame: "warzone", item: "shotgun" },
      criteria: CROSS_GAME_REWARD_CRITERIA,
    },
  });
}

export async function startRewardConsumer(nats: PlatformNatsClient, prisma: PrismaClient, logger: Logger) {
  const sub = nats.nc.subscribe(GAME_EVENT_WILDCARD);

  (async () => {
    for await (const msg of sub) {
      try {
        const raw = decodeJson<Record<string, unknown>>(msg.data);
        const envelope = EventEnvelopeSchema.parse(raw);
        const eventType = msg.subject.split(".")[2]; // game.<gameKey>.<eventType>
        const ctx: CriteriaContext = { eventType, gameKey: envelope.gameKey, payload: raw };

        const rewards = await prisma.reward.findMany({ where: { criteria: { not: Prisma.DbNull } } });
        const matched = rewards.filter((r) => matchesEventCriteria(r.criteria, ctx));
        if (matched.length === 0) continue;

        const user = await getOrCreateUser(prisma, envelope.walletAddress);
        const sourceGame = await prisma.game.findUnique({ where: { key: envelope.gameKey } });

        for (const reward of matched) {
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

          const targetGameKey = (reward.payload as Record<string, unknown> | null)?.targetGame as string | undefined;

          await nats.publishJson(PLATFORM_SUBJECTS.rewardGranted, {
            eventId: randomUUID(),
            occurredAt: new Date().toISOString(),
            walletAddress: envelope.walletAddress,
            rewardKey: reward.key,
            sourceGameKey: envelope.gameKey,
            targetGameKey,
          });

          logger.info({ wallet: envelope.walletAddress, reward: reward.key }, "cross-game reward granted");
        }
      } catch (err) {
        logger.error({ err }, "failed to process reward event");
      }
    }
  })().catch((err) => logger.error({ err }, "reward consumer loop crashed"));
}
