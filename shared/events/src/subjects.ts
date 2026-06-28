/**
 * NATS subject naming convention.
 *
 *   game.<gameKey>.<event>      — emitted by a game (via adapter today, native SDK later)
 *   platform.<domain>.<event>   — emitted by a platform service in reaction to game events
 *
 * One JetStream stream per domain (see architecture/05-nats-topics.md):
 *   GAME_EVENTS     subjects: "game.*.*"
 *   PLATFORM_EVENTS subjects: "platform.*.*"
 */

export const GAME_EVENTS_STREAM = "GAME_EVENTS";
export const PLATFORM_EVENTS_STREAM = "PLATFORM_EVENTS";

export function gameSubject(gameKey: string, event: GameEventName): string {
  return `game.${gameKey}.${event.toLowerCase()}`;
}

export function platformSubject(domain: string, event: string): string {
  return `platform.${domain}.${event.toLowerCase()}`;
}

export type GameEventName =
  | "GAME_SAVED"
  | "MISSION_COMPLETED"
  | "LEVEL_UP"
  | "GAME_FINISHED"
  | "GAME_INSTALLED"
  // Round 2 — managed save pipeline lifecycle (save-service / verification-service).
  // SAVE_COMPLETED carries the same payload shape as GAME_SAVED and is published
  // alongside it (not instead of it) so profile/leaderboard/achievement/reward-service's
  // existing GAME_SAVED consumers from Round 1 pick up managed saves with zero changes;
  // SAVE_REQUESTED/SAVE_COMPLETED/SAVE_VALIDATED exist for pipeline-lifecycle consumers
  // (verification-service, analytics, notification) that care about the save process
  // itself, not just the resulting state.
  | "SAVE_REQUESTED"
  | "SAVE_COMPLETED"
  | "SAVE_VALIDATED";

export const PLATFORM_SUBJECTS = {
  xpGained: platformSubject("user", "xp_gained"),
  achievementUnlocked: platformSubject("achievement", "unlocked"),
  rewardGranted: platformSubject("reward", "granted"),
  leaderboardUpdated: platformSubject("leaderboard", "updated"),
  playerLogin: platformSubject("user", "login"),
  profileUpdated: platformSubject("profile", "updated"),
  playerOnline: platformSubject("user", "online"),
  playerOffline: platformSubject("user", "offline"),
} as const;

export const GAME_EVENT_WILDCARD = "game.*.*";
export const PLATFORM_EVENT_WILDCARD = "platform.*.*";
