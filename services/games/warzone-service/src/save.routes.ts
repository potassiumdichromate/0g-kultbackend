import { Router } from "express";
import { WarzoneSaveDataSchema, extractCoinSnapshot } from "./save-schema";
import type { AuthedRequest } from "./auth";

const GAME_KEY = "warzone";

/**
 * Unity talks to THIS service, never to save-service directly (see
 * architecture/00-platform-vision.md — per-game services are the front door; save-service is
 * an internal platform mechanic). This service owns validation against Warzone's real shape;
 * save-service is schema-agnostic and trusts that validation already happened.
 */
export function createSaveRouter(saveServiceUrl: string): Router {
  const router = Router();

  router.post("/", async (req: AuthedRequest, res) => {
    const parsed = WarzoneSaveDataSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Save payload failed validation", issues: parsed.error.issues });
    }

    const upstream = await fetch(`${saveServiceUrl}/save/${GAME_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: req.headers.authorization! },
      body: JSON.stringify({ data: parsed.data, coinSnapshot: extractCoinSnapshot(parsed.data) }),
    });
    const body = await upstream.json();
    return res.status(upstream.status).json(body);
  });

  router.get("/", async (req: AuthedRequest, res) => {
    const upstream = await fetch(`${saveServiceUrl}/save/${GAME_KEY}`, {
      headers: { Authorization: req.headers.authorization! },
    });
    const body = await upstream.json();
    return res.status(upstream.status).json(body);
  });

  return router;
}
