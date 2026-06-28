import type { Logger } from "pino";
import { PrismaClient, Prisma } from "@platform/db";
import { decodeJson, type PlatformNatsClient } from "@platform/utils";
import { GAME_EVENT_WILDCARD, PLATFORM_EVENT_WILDCARD } from "@platform/events";

interface EventEnvelope {
  occurredAt?: string;
  gameKey?: string;
  walletAddress?: string;
}

/**
 * Append-only sink: every game.* and platform.* message becomes a RawEvent row. Deliberately
 * dumb — no schema-per-event-type validation here, that already happened at the producer via
 * the Zod schemas in @platform/events. Analytics just needs the fact that something happened.
 */
export async function startAnalyticsConsumer(nats: PlatformNatsClient, prisma: PrismaClient, logger: Logger) {
  const sub = nats.nc.subscribe(GAME_EVENT_WILDCARD);
  const platformSub = nats.nc.subscribe(PLATFORM_EVENT_WILDCARD);

  const consume = (subscription: typeof sub) =>
    (async () => {
      for await (const msg of subscription) {
        try {
          const payload = decodeJson<EventEnvelope>(msg.data);
          await prisma.rawEvent.create({
            data: {
              eventType: msg.subject,
              gameId: undefined,
              userId: undefined,
              payload: payload as Prisma.InputJsonValue,
              occurredAt: payload.occurredAt ? new Date(payload.occurredAt) : new Date(),
            },
          });
        } catch (err) {
          logger.error({ err, subject: msg.subject }, "failed to record raw event");
        }
      }
    })().catch((err) => logger.error({ err }, "analytics consumer loop crashed"));

  consume(sub);
  consume(platformSub);
}
