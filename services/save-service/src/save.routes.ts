import { Router } from "express";
import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { encode, decode } from "@msgpack/msgpack";
import type { Redis } from "ioredis";
import { PrismaClient, Prisma } from "@platform/db";
import { getOrCreateUser, RedisKeys, type PlatformNatsClient } from "@platform/utils";
import { gameSubject } from "@platform/events";
import type { StorageDriver, ComputeClient } from "@platform/zg-client";
import type { AuthedRequest } from "./auth";

export interface SaveRouterDeps {
  prisma: PrismaClient;
  redis: Redis;
  nats: PlatformNatsClient;
  storage: StorageDriver;
  compute: ComputeClient;
}

/**
 * THE managed save pipeline — fully generic, no per-game knowledge. Round 3 had this route
 * validate against a per-game Zod schema looked up from a shared static map; Round 4 moved
 * that ownership to each game's own service (services/games/*), which validates BEFORE
 * calling here and sends the already-validated payload plus whatever scalar index fields it
 * cares about. This route only ever sees `{ data, coinSnapshot?, important? }` — it has no
 * idea what game it's serving, by design (see architecture/00-platform-vision.md).
 *
 * 0G Storage (via `storage`) is the only place the encoded save bytes are persisted — see the
 * ground rule in shared/db/prisma/schema.prisma. Redis is a fast working copy, not a second
 * source of truth: flushing it loses nothing, because every save is always re-fetchable from
 * the storage driver via the rootHash Postgres holds.
 */
export function createSaveRouter(deps: SaveRouterDeps): Router {
  const { prisma, redis, nats, storage, compute } = deps;
  const router = Router();

  router.post("/:gameKey", async (req: AuthedRequest, res) => {
    const { gameKey } = req.params;
    const walletAddress = req.walletAddress!;

    const body = req.body as { data?: unknown; coinSnapshot?: number; important?: boolean };
    if (!body || typeof body !== "object" || body.data === undefined || body.data === null) {
      return res.status(400).json({ error: 'Request body must be { data: <validated save JSON>, coinSnapshot?, important? }' });
    }
    const saveData = body.data;
    const coinSnapshot = typeof body.coinSnapshot === "number" ? body.coinSnapshot : undefined;
    const important = body.important === true;

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
    const previousMetadata = (existing?.metadata as Record<string, unknown> | undefined) ?? {};
    const previousCoinSnapshot = previousMetadata.coinSnapshot as number | undefined;
    const previousSaveIndex = existing?.saveIndex;

    // Synchronous TEE gate, for events the caller has flagged as important (mission
    // completion, ranked results, tournament/NFT rewards, leaderboard submissions — see
    // architecture/09-security-model.md). Everything else keeps the fast async-only path:
    // verification-service checks it after the fact instead of blocking the response.
    let computeStatus: "pending" | "validated" | "rejected" | "skipped" = "pending";
    let computeResult: Awaited<ReturnType<ComputeClient["runAntiCheat"]>> | undefined;
    if (important) {
      const rootHashPlaceholder = `pending-${randomUUID()}`; // bound to the real upload below once computed
      computeResult = await compute.runAntiCheat(
        {
          rootHash: rootHashPlaceholder,
          saveIndex: nextSaveIndex,
          prevSaveIndex: previousSaveIndex ?? -1,
          coinDelta: (coinSnapshot ?? 0) - (previousCoinSnapshot ?? 0),
          timeElapsedMs: 0,
          saveData: { coinSnapshot },
        },
        IMPORTANT_EVENT_SYSTEM_PROMPT,
      );
      if (computeResult.verdict === "SUSPICIOUS") {
        return res.status(422).json({
          error: "Save rejected by synchronous anti-cheat verification",
          flags: computeResult.flags,
          confidence: computeResult.confidence,
        });
      }
      computeStatus = computeResult.verdict === "SKIPPED" ? "skipped" : "validated";
    }

    // Step 1: fast working copy in Redis. This is a cache, not the save.
    const cacheKey = RedisKeys.savedGameCache(gameKey, walletAddress);
    await redis.set(cacheKey, JSON.stringify(saveData));

    // Step 2: encode + compress + upload to 0G Storage — the actual save.
    const encoded = Buffer.from(encode(saveData));
    const compressed = gzipSync(encoded);
    const { rootHash } = await storage.upload(compressed);

    await prisma.userGameProgress.upsert({
      where: { userId_gameId: { userId: user.id, gameId: game.id } },
      update: {
        rootHash,
        saveIndex: nextSaveIndex,
        lastSaveTime: new Date(),
        metadata: {
          coinSnapshot,
          encoding: "msgpack+gzip",
          storageMode: storage.mode,
          computeStatus,
          ...(computeResult ? { verdict: computeResult.verdict, teeVerified: computeResult.teeVerified } : {}),
        } satisfies Prisma.InputJsonValue,
      },
      create: {
        userId: user.id,
        gameId: game.id,
        rootHash,
        saveIndex: nextSaveIndex,
        lastSaveTime: new Date(),
        metadata: {
          coinSnapshot,
          encoding: "msgpack+gzip",
          storageMode: storage.mode,
          computeStatus,
          ...(computeResult ? { verdict: computeResult.verdict, teeVerified: computeResult.teeVerified } : {}),
        } satisfies Prisma.InputJsonValue,
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
      // "pending" only when NOT already synchronously gated — tells verification-service's
      // async consumer whether there's anything left for it to do for this specific save.
      computeStatus,
    };
    // SAVE_COMPLETED for pipeline-lifecycle consumers (verification-service); GAME_SAVED
    // (same shape) so every profile/leaderboard/achievement/reward-service consumer picks up
    // managed saves with zero changes — see shared/events/src/subjects.ts.
    await nats.publishJson(gameSubject(gameKey, "SAVE_COMPLETED"), savedPayload);
    await nats.publishJson(gameSubject(gameKey, "GAME_SAVED"), savedPayload);

    return res.status(201).json({ rootHash, saveIndex: nextSaveIndex, computeStatus });
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

const IMPORTANT_EVENT_SYSTEM_PROMPT = `You are an anti-cheat validator gating an IMPORTANT save (mission completion,
ranked result, tournament/NFT reward, or leaderboard submission) BEFORE it is committed — your verdict can block it.
You receive saveIndex, prevSaveIndex, coinDelta, timeElapsed (ms), saveData, and rootHash. Flag SUSPICIOUS if coinDelta
is implausibly large for the elapsed time, saveIndex did not strictly increase, or any resource field is negative.
Otherwise return CLEAN. Respond ONLY with JSON: {"verdict":"CLEAN"|"SUSPICIOUS","confidence":0-1,"flags":string[],"rootHash":"<echo input exactly>"}`;
