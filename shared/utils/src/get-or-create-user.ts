import { Prisma, PrismaClient } from "@platform/db";

/**
 * Every consumer of game.*.* events (profile-service, leaderboard-service,
 * achievement-service, reward-service) independently needs "the User row for this wallet,
 * creating it if this is the first event we've ever seen for them." Because NATS delivers
 * the same event to all of them in parallel, a plain `prisma.user.upsert()` races: two
 * services can both see "doesn't exist yet" and both attempt the INSERT, and the loser gets
 * a P2002 unique-constraint error instead of the row. This wraps that race: on conflict,
 * just re-read the row the winner created.
 */
export async function getOrCreateUser(prisma: PrismaClient, walletAddress: string) {
  try {
    return await prisma.user.upsert({
      where: { walletAddress },
      update: {},
      create: { walletAddress },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return prisma.user.findUniqueOrThrow({ where: { walletAddress } });
    }
    throw err;
  }
}
