import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { randomUUID } from "node:crypto";
import { gameSubject } from "@platform/events";
import type { PlatformNatsClient } from "./nats-client";

/**
 * Phase-1, zero-touch integration: both ZeroDash and Warzone already expose
 *   GET /player/leaderboard/decentralized  -> [{ walletAddress, saveIndex, coinSnapshot, daStatus }]
 *   GET /player/save/metadata?wallet=0x... -> { saves: [{ rootHash, saveIndex, checksum, daStatus, computeStatus, coinSnapshot, ... }] }
 * (see docs/repository-mapping.md). This adapter polls the first to discover wallets +
 * their current saveIndex, and only calls the second — to fetch the rootHash — when a
 * wallet's saveIndex has actually advanced since last poll. No game code changes needed.
 *
 * One function, two adapters (zerodash-adapter, warzone-adapter) just supply config —
 * this is the reuse the platform analysis flagged: identical polling logic shouldn't be
 * copy-pasted per game any more than the 0G storage/chain/DA clients should be.
 */

export interface GameSaveAdapterOptions {
  gameKey: string;
  backendBaseUrl: string;
  pollIntervalMs: number;
  redis: Redis;
  nats: PlatformNatsClient;
  logger: Logger;
}

interface LeaderboardEntry {
  walletAddress: string;
  saveIndex: number;
  coinSnapshot?: number;
  daStatus?: string;
}

interface SaveMetadataRecord {
  rootHash: string;
  saveIndex: number;
  checksum?: string;
  daStatus?: string;
  computeStatus?: string;
  coinSnapshot?: number;
}

function lastSeenKey(gameKey: string, wallet: string): string {
  return `adapter:${gameKey}:lastSeenSaveIndex:${wallet.toLowerCase()}`;
}

export function startGameSaveAdapter(opts: GameSaveAdapterOptions): { stop: () => void } {
  const { gameKey, backendBaseUrl, pollIntervalMs, redis, nats, logger } = opts;

  const tick = async () => {
    try {
      const res = await fetch(`${backendBaseUrl}/player/leaderboard/decentralized`);
      if (!res.ok) {
        logger.warn({ gameKey, status: res.status }, "leaderboard poll failed");
        return;
      }
      const body = (await res.json()) as { leaderboard?: LeaderboardEntry[] };
      const entries = body.leaderboard ?? [];

      for (const entry of entries) {
        await checkAndEmit(entry);
      }
    } catch (err) {
      logger.error({ gameKey, err }, "adapter poll tick failed");
    }
  };

  const checkAndEmit = async (entry: LeaderboardEntry) => {
    const key = lastSeenKey(gameKey, entry.walletAddress);
    const lastSeen = await redis.get(key);
    const lastSeenIndex = lastSeen ? parseInt(lastSeen, 10) : -1;

    if (entry.saveIndex <= lastSeenIndex) return;

    const metaRes = await fetch(
      `${backendBaseUrl}/player/save/metadata?wallet=${entry.walletAddress}`,
    );
    if (!metaRes.ok) {
      logger.warn({ gameKey, wallet: entry.walletAddress }, "save metadata fetch failed");
      return;
    }
    const meta = (await metaRes.json()) as { saves?: SaveMetadataRecord[] };
    const latest = meta.saves?.[0];
    if (!latest) return;

    await nats.publishJson(gameSubject(gameKey, "GAME_SAVED"), {
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      gameKey,
      walletAddress: entry.walletAddress.toLowerCase(),
      rootHash: latest.rootHash,
      saveIndex: latest.saveIndex,
      checksum: latest.checksum,
      daStatus: latest.daStatus,
      computeStatus: latest.computeStatus,
      coinSnapshot: latest.coinSnapshot,
    });

    await redis.set(key, String(latest.saveIndex));
    logger.info(
      { gameKey, wallet: entry.walletAddress, saveIndex: latest.saveIndex },
      "GAME_SAVED published",
    );
  };

  const interval = setInterval(tick, pollIntervalMs);
  void tick();

  return { stop: () => clearInterval(interval) };
}
