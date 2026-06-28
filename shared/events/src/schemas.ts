import { z } from "zod";

/**
 * Every game event carries this envelope. `gameKey` + `walletAddress` let any consumer
 * resolve to a platform User/Game row without the producer needing to know about
 * Postgres ids — adapters and a future native SDK only ever deal in wallet addresses.
 */
export const EventEnvelopeSchema = z.object({
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  gameKey: z.string(),
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

export const GameSavedPayloadSchema = EventEnvelopeSchema.extend({
  rootHash: z.string(),
  saveIndex: z.number().int().nonnegative(),
  checksum: z.string().optional(),
  daStatus: z.enum(["pending", "finalized", "failed", "skipped"]).optional(),
  computeStatus: z.enum(["skipped", "pending", "validated", "rejected"]).optional(),
  coinSnapshot: z.number().optional(),
});

export const MissionCompletedPayloadSchema = EventEnvelopeSchema.extend({
  missionId: z.string(),
  reward: z.record(z.unknown()).optional(),
});

export const LevelUpPayloadSchema = EventEnvelopeSchema.extend({
  newLevel: z.number().int().positive(),
  previousLevel: z.number().int().nonnegative(),
});

export const GameFinishedPayloadSchema = EventEnvelopeSchema.extend({
  score: z.number(),
  durationSeconds: z.number().nonnegative().optional(),
});

export const XpGainedPayloadSchema = z.object({
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  walletAddress: z.string(),
  sourceGameKey: z.string(),
  amount: z.number().int(),
});

export const AchievementUnlockedPayloadSchema = z.object({
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  walletAddress: z.string(),
  achievementKey: z.string(),
  sourceGameKey: z.string().optional(),
});

export const RewardGrantedPayloadSchema = z.object({
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  walletAddress: z.string(),
  rewardKey: z.string(),
  sourceGameKey: z.string().optional(),
  targetGameKey: z.string().optional(), // e.g. "warzone" when granting a cross-game gun unlock
});

export const GameInstalledPayloadSchema = EventEnvelopeSchema;

// --- Round 2: managed save pipeline lifecycle (save-service / verification-service) ---

/** Published the instant save-service receives a request, before any processing. */
export const SaveRequestedPayloadSchema = EventEnvelopeSchema;

/**
 * Published by save-service once the encoded blob is confirmed written to 0G Storage (the
 * source of truth) — NOT when the Redis working copy is written. A superset of
 * GameSavedPayloadSchema: save-service publishes the same object to both the SAVE_COMPLETED
 * subject (for verification-service, which needs previousCoinSnapshot/previousSaveIndex to
 * compute a real delta, faithfully reapplying ZeroGCompute.js's trigger heuristic) and the
 * GAME_SAVED subject (for Round 1's profile/leaderboard/achievement/reward-service
 * consumers, which parse it against the narrower GameSavedPayloadSchema and simply ignore
 * the extra fields — Zod doesn't reject unknown keys on .parse() by default).
 */
export const SaveCompletedPayloadSchema = GameSavedPayloadSchema.extend({
  previousCoinSnapshot: z.number().optional(),
  previousSaveIndex: z.number().int().optional(),
});

export const SaveValidatedPayloadSchema = EventEnvelopeSchema.extend({
  rootHash: z.string(),
  verdict: z.enum(["CLEAN", "SUSPICIOUS", "SKIPPED"]),
  confidence: z.number().min(0).max(1).optional(),
  flags: z.array(z.string()).optional(),
  teeVerified: z.boolean().optional(),
});

// --- Round 2: identity / presence (schemas defined now; some have no live producer yet —
// see docs/repository-mapping.md for which ones are wired vs. reserved) ---

export const PlayerLoginPayloadSchema = z.object({
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  walletAddress: z.string(),
});

export const ProfileUpdatedPayloadSchema = z.object({
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  walletAddress: z.string(),
  fields: z.array(z.string()), // e.g. ["xpTotal", "level"]
});

export const PlayerOnlinePayloadSchema = z.object({
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  walletAddress: z.string(),
  gameKey: z.string().optional(),
});

export const PlayerOfflinePayloadSchema = PlayerOnlinePayloadSchema;

export type GameSavedPayload = z.infer<typeof GameSavedPayloadSchema>;
export type MissionCompletedPayload = z.infer<typeof MissionCompletedPayloadSchema>;
export type LevelUpPayload = z.infer<typeof LevelUpPayloadSchema>;
export type GameFinishedPayload = z.infer<typeof GameFinishedPayloadSchema>;
export type XpGainedPayload = z.infer<typeof XpGainedPayloadSchema>;
export type AchievementUnlockedPayload = z.infer<typeof AchievementUnlockedPayloadSchema>;
export type RewardGrantedPayload = z.infer<typeof RewardGrantedPayloadSchema>;
export type GameInstalledPayload = z.infer<typeof GameInstalledPayloadSchema>;
export type SaveRequestedPayload = z.infer<typeof SaveRequestedPayloadSchema>;
export type SaveCompletedPayload = z.infer<typeof SaveCompletedPayloadSchema>;
export type SaveValidatedPayload = z.infer<typeof SaveValidatedPayloadSchema>;
export type PlayerLoginPayload = z.infer<typeof PlayerLoginPayloadSchema>;
export type ProfileUpdatedPayload = z.infer<typeof ProfileUpdatedPayloadSchema>;
export type PlayerOnlinePayload = z.infer<typeof PlayerOnlinePayloadSchema>;
export type PlayerOfflinePayload = z.infer<typeof PlayerOfflinePayloadSchema>;
