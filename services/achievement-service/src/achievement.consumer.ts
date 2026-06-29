import type { Logger } from "pino";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@platform/db";
import {
  decodeJson,
  getOrCreateUser,
  matchesEventCriteria,
  type CriteriaContext,
  type PlatformNatsClient,
} from "@platform/utils";
import { GAME_EVENT_WILDCARD, EventEnvelopeSchema, PLATFORM_SUBJECTS } from "@platform/events";

/**
 * Round 3: criteria are no longer matched by one hardcoded function per achievement — every
 * Achievement row's `criteria` (an EventCriteria value, shared/utils/src/criteria.ts) is
 * evaluated generically against every incoming game.*.* event. Adding achievement #2 is a
 * database row, not a code change. The seed below is the one example wired end to end, not
 * the only achievement the system can support.
 */
const FIRST_SAVE_ACHIEVEMENT_KEY = "first_save";

/**
 * platform.user.xp_gained had a schema in Round 1 but no producer. This is the wiring:
 * a simple, fixed amount per achievement unlock — a provable rule, not a full XP economy
 * design. MISSION_COMPLETED/LEVEL_UP would be natural additional XP sources once a game
 * adapter or native SDK actually emits them (none does yet — see docs/repository-mapping.md).
 */
const XP_PER_ACHIEVEMENT = 50;

const FIRST_SAVE_CRITERIA = { type: "first_event" as const, eventType: "game_saved" };

export async function ensureSeedAchievements(prisma: PrismaClient) {
  // `update` re-applies criteria on every startup, not just `{}` — see reward.consumer.ts
  // for why an upsert that only sets fields on `create` silently never backfills a row
  // that already existed before that field's value changed.
  await prisma.achievement.upsert({
    where: { key: FIRST_SAVE_ACHIEVEMENT_KEY },
    update: { criteria: FIRST_SAVE_CRITERIA },
    create: {
      key: FIRST_SAVE_ACHIEVEMENT_KEY,
      name: "First Steps",
      description: "Save progress in any game on the platform for the first time.",
      criteria: FIRST_SAVE_CRITERIA,
    },
  });
}

export async function startAchievementConsumer(nats: PlatformNatsClient, prisma: PrismaClient, logger: Logger) {
  const sub = nats.nc.subscribe(GAME_EVENT_WILDCARD);

  (async () => {
    for await (const msg of sub) {
      try {
        const raw = decodeJson<Record<string, unknown>>(msg.data);
        const envelope = EventEnvelopeSchema.parse(raw);
        const eventType = msg.subject.split(".")[2]; // game.<gameKey>.<eventType>
        const ctx: CriteriaContext = { eventType, gameKey: envelope.gameKey, payload: raw };

        const achievements = await prisma.achievement.findMany();
        const matched = achievements.filter((a) => matchesEventCriteria(a.criteria, ctx));
        if (matched.length === 0) continue;

        const user = await getOrCreateUser(prisma, envelope.walletAddress);

        for (const achievement of matched) {
          const existing = await prisma.userAchievement.findUnique({
            where: { userId_achievementId: { userId: user.id, achievementId: achievement.id } },
          });
          if (existing) continue;

          await prisma.userAchievement.create({
            data: { userId: user.id, achievementId: achievement.id },
          });

          await nats.publishJson(PLATFORM_SUBJECTS.achievementUnlocked, {
            eventId: randomUUID(),
            occurredAt: new Date().toISOString(),
            walletAddress: envelope.walletAddress,
            achievementKey: achievement.key,
            sourceGameKey: envelope.gameKey,
          });

          await nats.publishJson(PLATFORM_SUBJECTS.xpGained, {
            eventId: randomUUID(),
            occurredAt: new Date().toISOString(),
            walletAddress: envelope.walletAddress,
            sourceGameKey: envelope.gameKey,
            amount: XP_PER_ACHIEVEMENT,
          });

          logger.info({ wallet: envelope.walletAddress, achievement: achievement.key }, "achievement unlocked");
        }
      } catch (err) {
        logger.error({ err }, "failed to process achievement event");
      }
    }
  })().catch((err) => logger.error({ err }, "achievement consumer loop crashed"));
}
