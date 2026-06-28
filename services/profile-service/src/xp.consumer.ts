import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { PrismaClient } from "@platform/db";
import { decodeJson, getOrCreateUser, type PlatformNatsClient } from "@platform/utils";
import { PLATFORM_EVENT_WILDCARD, PLATFORM_SUBJECTS, XpGainedPayloadSchema } from "@platform/events";

/** Simple, documented formula — not a tuned game economy: every 100 XP is one level. */
function levelForXp(xpTotal: number): number {
  return Math.floor(xpTotal / 100) + 1;
}

/**
 * platform.user.xp_gained had a schema since Round 1 but no consumer. This closes the loop:
 * achievement-service (and, once wired, mission/level-up sources) publish it; profile-service
 * is the single writer of User.xpTotal/level, then announces PROFILE_UPDATED so any future
 * consumer (e.g. a live UI push) doesn't need to know XP was the cause.
 */
export async function startXpConsumer(nats: PlatformNatsClient, prisma: PrismaClient, logger: Logger) {
  const sub = nats.nc.subscribe(PLATFORM_EVENT_WILDCARD);

  (async () => {
    for await (const msg of sub) {
      try {
        if (msg.subject !== PLATFORM_SUBJECTS.xpGained) continue;
        const payload = XpGainedPayloadSchema.parse(decodeJson<unknown>(msg.data));

        const user = await getOrCreateUser(prisma, payload.walletAddress);
        const newXpTotal = user.xpTotal + payload.amount;
        const newLevel = levelForXp(newXpTotal);

        await prisma.user.update({
          where: { id: user.id },
          data: { xpTotal: newXpTotal, level: newLevel },
        });

        await nats.publishJson(PLATFORM_SUBJECTS.profileUpdated, {
          eventId: randomUUID(),
          occurredAt: new Date().toISOString(),
          walletAddress: payload.walletAddress,
          fields: ["xpTotal", "level"],
        });

        logger.info(
          { wallet: payload.walletAddress, xpTotal: newXpTotal, level: newLevel },
          "xp applied to user profile",
        );
      } catch (err) {
        logger.error({ err }, "failed to process xp_gained event");
      }
    }
  })().catch((err) => logger.error({ err }, "xp consumer loop crashed"));
}
