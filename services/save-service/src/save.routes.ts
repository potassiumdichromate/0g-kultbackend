import { Router } from "express";
import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { encode, decode } from "@msgpack/msgpack";
import type { Redis } from "ioredis";
import { PrismaClient } from "@platform/db";
import { getOrCreateUser, RedisKeys, type PlatformNatsClient } from "@platform/utils";
import { gameSubject } from "@platform/events";
import { SAVE_DATA_SCHEMAS, extractCoinSnapshot } from "@platform/dto";
import type { StorageDriver } from "@platform/zg-client";
import type { AuthedRequest } from "./auth";

export interface SaveRouterDeps {
  prisma: PrismaClient;
  redis: Redis;
  nats: PlatformNatsClient;
  storage: StorageDriver;
}

/**
 * THE managed save pipeline. 0G Storage (via `storage`) is the only place the encoded save
 * bytes are persisted — see the ground rule in shared/db/prisma/schema.prisma. Redis is a
 * fast working copy, not a second source of truth: flushing it loses nothing, because every
 * save is always re-fetchable from the storage driver via the rootHash Postgres holds.
 */
export function createSaveRouter(deps: SaveRouterDeps): Router {
  const { prisma, redis, nats, storage } = deps;
  const router = Router();

  router.post("/:gameKey", async (req: AuthedRequest, res) => {
    const { gameKey } = req.params;
    const walletAddress = req.walletAddress!;

    const schema = SAVE_DATA_SCHEMAS[gameKey];
    if (!schema) {
      return res.status(400).json({ error: `No save schema registered for game "${gameKey}"` });
    }

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Save payload failed validation", issues: parsed.error.issues });
    }
    const saveData = parsed.data;

    const game = await prisma.game.findUnique({ where: { key: gameKey } });
    if (!game) {
      return res.status(404).json({ error: `Unknown game "${gameKey}"` });
    }

    await nats.publishJson(gameSubject(gameKey, "SAVE_REQUESTED"), {
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      gameKey,
      walletAddress,
    });

    const user = await getOrCreateUser(prisma, walletAddress);

    // saveIndex is always server-computed, never accepted from the client — there is no
    // anti-rollback header to spoof here, unlike the legacy binary endpoints.
    const existing = await prisma.userGameProgress.findUnique({
      where: { userId_gameId: { userId: user.id, gameId: game.id } },
    });
    const nextSaveIndex = (existing?.saveIndex ?? -1) + 1;

    // Step 1: fast working copy in Redis. This is a cache, not the save.
    const cacheKey = RedisKeys.savedGameCache(gameKey, walletAddress);
    await redis.set(cacheKey, JSON.stringify(saveData));

    // Step 2: encode + compress + upload to 0G Storage — the actual save.
    const encoded = Buffer.from(encode(saveData));
    const compressed = gzipSync(encoded);
    const { rootHash } = await storage.upload(compressed);

    const coinSnapshot = extractCoinSnapshot[gameKey]?.(saveData);
    const previousMetadata = (existing?.metadata as Record<string, unknown> | undefined) ?? {};
    const previousCoinSnapshot = previousMetadata.coinSnapshot as number | undefined;
    const previousSaveIndex = existing?.saveIndex;

    await prisma.userGameProgress.upsert({
      where: { userId_gameId: { userId: user.id, gameId: game.id } },
      update: {
        rootHash,
        saveIndex: nextSaveIndex,
        lastSaveTime: new Date(),
        metadata: { coinSnapshot, encoding: "msgpack+gzip", storageMode: storage.mode },
      },
      create: {
        userId: user.id,
        gameId: game.id,
        rootHash,
        saveIndex: nextSaveIndex,
        lastSaveTime: new Date(),
        metadata: { coinSnapshot, encoding: "msgpack+gzip", storageMode: storage.mode },
      },
    });

    const savedPayload = {
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      gameKey,
      walletAddress,
      rootHash,
      saveIndex: nextSaveIndex,
      coinSnapshot,
      previousCoinSnapshot,
      previousSaveIndex,
      computeStatus: "pending" as const,
    };
    // SAVE_COMPLETED for pipeline-lifecycle consumers (verification-service); GAME_SAVED
    // (same shape) so Round 1's profile/leaderboard/achievement/reward-service consumers
    // pick up managed saves with zero changes — see shared/events/src/subjects.ts.
    await nats.publishJson(gameSubject(gameKey, "SAVE_COMPLETED"), savedPayload);
    await nats.publishJson(gameSubject(gameKey, "GAME_SAVED"), savedPayload);

    return res.status(201).json({ rootHash, saveIndex: nextSaveIndex });
  });

  router.get("/:gameKey", async (req: AuthedRequest, res) => {
    const { gameKey } = req.params;
    const walletAddress = req.walletAddress!;

    const cacheKey = RedisKeys.savedGameCache(gameKey, walletAddress);
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const game = await prisma.game.findUnique({ where: { key: gameKey } });
    if (!game) {
      return res.status(404).json({ error: `Unknown game "${gameKey}"` });
    }
    const user = await prisma.user.findUnique({ where: { walletAddress } });
    const progress = user
      ? await prisma.userGameProgress.findUnique({ where: { userId_gameId: { userId: user.id, gameId: game.id } } })
      : null;
    if (!progress) {
      return res.status(404).json({ error: "No save found for this wallet" });
    }

    // Recovered entirely from 0G Storage — proves Redis was never the source of truth.
    const compressed = await storage.download(progress.rootHash);
    const encoded = gunzipSync(compressed);
    const saveData = decode(encoded);

    await redis.set(cacheKey, JSON.stringify(saveData));
    return res.json(saveData);
  });

  return router;
}
