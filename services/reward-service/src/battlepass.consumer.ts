import type { Logger } from "pino";
import { PrismaClient } from "@platform/db";
import { decodeJson, getOrCreateUser, type PlatformNatsClient } from "@platform/utils";
import { PLATFORM_EVENT_WILDCARD, PLATFORM_SUBJECTS, XpGainedPayloadSchema } from "@platform/events";

const SEASON_KEY = "season_1";
/** Simple, documented formula — not a tuned game economy: every 100 XP is one battle-pass tier. */
function tierForXp(xp: number): number {
  return Math.floor(xp / 100);
}

/**
 * Completes the chain the user described: mission -> XP -> achievement -> battle pass ->
 * reward -> profile -> analytics -> notification. gameId is always null here — this is
 * the platform-WIDE battle pass (cross-game XP feeding one shared pass), the "shared
 * ecosystem" property of the platform, not a per-game battle pass.
 */
export async function startBattlePassConsumer(nats: PlatformNatsClient, prisma: PrismaClient, logger: Logger) {
  const sub = nats.nc.subscribe(PLATFORM_EVENT_WILDCARD);

  (async () => {
    for await (const msg of sub) {
      try {
        if (msg.subject !== PLATFORM_SUBJECTS.xpGained) continue;
        const payload = XpGainedPayloadSchema.parse(decodeJson<unknown>(msg.data));

        const user = await getOrCreateUser(prisma, payload.walletAddress);

        // Not prisma's upsert(): Prisma deliberately disallows null inside a compound-unique
        // lookup, because Postgres treats every NULL as distinct and won't enforce
        // uniqueness across them — the same reason getOrCreateUser exists for User. This
        // single-instance, sequentially-processed consumer never races itself, so a plain
        // find-then-write is correct today; horizontally scaling reward-service would need
        // a real fix (e.g. a non-null sentinel "PLATFORM" gameId) — noted in
        // architecture/09-security-model.md rather than solved here.
        const existing = await prisma.battlePassProgress.findFirst({
          where: { userId: user.id, gameId: null, seasonKey: SEASON_KEY },
        });

        const newXp = (existing?.xp ?? 0) + payload.amount;
        const previousTier = existing?.tier ?? 0;
        const newTier = tierForXp(newXp);

        if (existing) {
          await prisma.battlePassProgress.update({
            where: { id: existing.id },
            data: { xp: newXp, tier: newTier },
          });
        } else {
          await prisma.battlePassProgress.create({
            data: { userId: user.id, gameId: null, seasonKey: SEASON_KEY, xp: newXp, tier: newTier },
          });
        }

        if (newTier > previousTier) {
          logger.info(
            { wallet: payload.walletAddress, previousTier, newTier, xp: newXp },
            "platform-wide battle pass tier advanced",
          );
        }
      } catch (err) {
        logger.error({ err }, "failed to process xp_gained event for battle pass");
      }
    }
  })().catch((err) => logger.error({ err }, "battle pass consumer loop crashed"));
}
