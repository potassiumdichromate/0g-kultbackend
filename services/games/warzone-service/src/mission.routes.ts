import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Logger } from "pino";
import type { PlatformNatsClient } from "@platform/utils";
import { gameSubject } from "@platform/events";
import type { ComputeClient } from "@platform/zg-client";
import type { AuthedRequest } from "./auth";

const GAME_KEY = "warzone";

const MissionCompletedBodySchema = z.object({
  missionId: z.string(),
  kills: z.number().int().nonnegative(),
  timeSeconds: z.number().nonnegative(),
});

const MISSION_SYSTEM_PROMPT = `You are an anti-cheat validator for a Warzone Warriors mission completion report — your
verdict can BLOCK the report before it's accepted. You receive { missionId, kills, timeSeconds, rootHash }. Flag
SUSPICIOUS if kills is implausibly high for timeSeconds (more than roughly 1 kill per 2 seconds sustained), or
timeSeconds is unrealistically low (under 5 seconds) for a mission completion. Otherwise return CLEAN. Respond ONLY
with JSON: {"verdict":"CLEAN"|"SUSPICIOUS","confidence":0-1,"flags":string[],"rootHash":"<echo input exactly>"}`;

export interface MissionRouterDeps {
  nats: PlatformNatsClient;
  compute: ComputeClient;
  logger: Logger;
}

/**
 * Mission completion is explicitly listed (by the user) as an "important event" — gated
 * synchronously through 0G Compute TEE verification BEFORE the event is published, not
 * checked after the fact. Same graceful-skip behavior as everywhere else when no
 * ZG_COMPUTE_API_KEY is configured (this is a real path, testable without real credentials).
 */
export function createMissionRouter(deps: MissionRouterDeps): Router {
  const { nats, compute, logger } = deps;
  const router = Router();

  router.post("/", async (req: AuthedRequest, res) => {
    const parsed = MissionCompletedBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Mission report failed validation", issues: parsed.error.issues });
    }
    const { missionId, kills, timeSeconds } = parsed.data;
    const walletAddress = req.walletAddress!;

    const reportHash = `mission-${randomUUID()}`; // binding token for this report, not a 0G rootHash
    const verdict = await compute.runAntiCheat(
      {
        rootHash: reportHash,
        saveIndex: 0,
        prevSaveIndex: 0,
        coinDelta: 0,
        timeElapsedMs: timeSeconds * 1000,
        saveData: { missionId, kills, timeSeconds },
      },
      MISSION_SYSTEM_PROMPT,
    );

    if (verdict.verdict === "SUSPICIOUS") {
      logger.warn({ wallet: walletAddress, missionId, kills, timeSeconds }, "mission report rejected by sync TEE gate");
      return res.status(422).json({ error: "Mission report rejected by anti-cheat verification", flags: verdict.flags });
    }

    await nats.publishJson(gameSubject(GAME_KEY, "MISSION_COMPLETED"), {
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      gameKey: GAME_KEY,
      walletAddress,
      missionId,
      metrics: { kills, timeSeconds },
      teeVerified: verdict.teeVerified ?? false,
    });

    logger.info({ wallet: walletAddress, missionId, verdict: verdict.verdict }, "mission completed");
    return res.status(201).json({ missionId, verdict: verdict.verdict });
  });

  return router;
}
