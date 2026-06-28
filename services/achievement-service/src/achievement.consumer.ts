import type { Logger } from "pino";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@platform/db";
import { decodeJson, getOrCreateUser, type PlatformNatsClient } from "@platform/utils";
import { GAME_EVENT_WILDCARD, GameSavedPayloadSchema, PLATFORM_SUBJECTS } from "@platform/events";

/**
 * Achievement criteria are stored declaratively on the Achievement row (criteria Json) so
 * new achievements can be added by inserting a row, not shipping code. This skeleton wires
 * exactly one rule end to end ("first save on any game") to prove the event -> rule ->
 * UserAchievement -> ACHIEVEMENT_UNLOCKED pipeline; a real implementation would load all
 * Achievement rows and run a small rule-matcher per incoming event type.
 */
const FIRST_SAVE_ACHIEVEMENT_KEY = "first_save";

/**
 * platform.user.xp_gained had a schema in Round 1 but no producer. This is the wiring:
 * a simple, fixed amount per achievement unlock — a provable rule, not a full XP economy
 * design. MISSION_COMPLETED/LEVEL_UP would be natural additional XP sources once a game
 * adapter or native SDK actually emits them (none does yet — see docs/repository-mapping.md).
 */
const XP_PER_ACHIEVEMENT = 50;

export async function ensureSeedAchievements(prisma: PrismaClient) {
  await prisma.achievement.upsert({
    where: { key: FIRST_SAVE_ACHIEVEMENT_KEY },
    update: {},
    create: {
      key: FIRST_SAVE_ACHIEVEMENT_KEY,
      name: "First Steps",
      description: "Save progress in any game on the platform for the first time.",
      criteria: { type: "first_event", eventType: "game_saved" },
    },
  });
}

export async function startAchievementConsumer(nats: PlatformNatsClient, prisma: PrismaClient, logger: Logger) {
  const sub = nats.nc.subscribe(GAME_EVENT_WILDCARD);

  (async () => {
    for await (const msg of sub) {
      try {
        if (!msg.subject.endsWith(".game_saved")) continue;
        const payload = GameSavedPayloadSchema.parse(decodeJson<unknown>(msg.data));

        const user = await getOrCreateUser(prisma, payload.walletAddress);

        const achievement = await prisma.achievement.findUnique({
          where: { key: FIRST_SAVE_ACHIEVEMENT_KEY },
        });
        if (!achievement) continue;

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
          walletAddress: payload.walletAddress,
          achievementKey: achievement.key,
          sourceGameKey: payload.gameKey,
        });

        await nats.publishJson(PLATFORM_SUBJECTS.xpGained, {
          eventId: randomUUID(),
          occurredAt: new Date().toISOString(),
          walletAddress: payload.walletAddress,
          sourceGameKey: payload.gameKey,
          amount: XP_PER_ACHIEVEMENT,
        });

        logger.info({ wallet: payload.walletAddress, achievement: achievement.key }, "achievement unlocked");
      } catch (err) {
        logger.error({ err }, "failed to process achievement event");
      }
    }
  })().catch((err) => logger.error({ err }, "achievement consumer loop crashed"));
}
