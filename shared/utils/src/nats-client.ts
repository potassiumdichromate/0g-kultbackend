import { connect, NatsConnection, JetStreamClient, JetStreamManager, StringCodec } from "nats";

const sc = StringCodec();

export interface PlatformNatsClient {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
  publishJson<T>(subject: string, payload: T): Promise<void>;
  close(): Promise<void>;
}

/**
 * Ensures the two durable streams described in architecture/05-nats-topics.md exist, then
 * returns a small wrapper around JetStream publish so services don't repeat connection
 * boilerplate. JetStream (not core NATS) is used deliberately: a missed MISSION_COMPLETED
 * event because achievement-service was momentarily down would silently cost a player a
 * reward — that's not acceptable once rewards have real value.
 */
export async function createPlatformNatsClient(
  natsUrl: string,
  streams: Array<{ name: string; subjects: string[] }>,
): Promise<PlatformNatsClient> {
  const nc = await connect({ servers: natsUrl });
  const js = nc.jetstream();
  const jsm = await nc.jetstreamManager();

  for (const stream of streams) {
    try {
      await jsm.streams.info(stream.name);
    } catch {
      await jsm.streams.add({ name: stream.name, subjects: stream.subjects });
    }
  }

  return {
    nc,
    js,
    jsm,
    async publishJson<T>(subject: string, payload: T) {
      await js.publish(subject, sc.encode(JSON.stringify(payload)));
    },
    async close() {
      await nc.close();
    },
  };
}

export function decodeJson<T>(data: Uint8Array): T {
  return JSON.parse(sc.decode(data)) as T;
}
