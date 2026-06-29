/**
 * Generic rule matcher shared by achievement-service and reward-service. Round 2 had one
 * hardcoded TypeScript function per rule (one achievement, one cross-game reward) — exactly
 * the "criteria should be data, not code" gap flagged in architecture/00-platform-vision.md.
 * This is that gap closed: every Achievement/Reward row carries an EventCriteria value in its
 * `criteria` column, and both services run the *same* evaluator against the event stream.
 * Adding achievement #2 or reward #2 is a database row from here on, never a new function.
 */

export type EventCriteria =
  | {
      type: "first_event";
      /** Event name as it appears after the last "." in the NATS subject, e.g. "game_saved". */
      eventType: string;
      /** Restrict to one game's events; omit for a platform-wide rule (any game qualifies). */
      gameKey?: string;
    }
  | {
      type: "threshold";
      eventType: string;
      gameKey?: string;
      /** Field to read off the event payload, e.g. "coinSnapshot". */
      field: string;
      op: ">=" | ">" | "<=" | "<" | "==";
      value: number;
    };

export interface CriteriaContext {
  eventType: string;
  gameKey: string;
  payload: Record<string, unknown>;
}

/**
 * Returns whether this event satisfies the rule's *trigger condition*. Does NOT check
 * whether the user already has the achievement/reward — that one-time-grant dedupe stays in
 * each service (a `findUnique`/`findFirst` against UserAchievement/UserReward before
 * creating), since it's a property of "already granted," not of "did this event qualify."
 */
export function matchesEventCriteria(criteria: unknown, ctx: CriteriaContext): boolean {
  if (!criteria || typeof criteria !== "object") return false;
  const c = criteria as EventCriteria;

  if (c.eventType !== ctx.eventType) return false;
  if (c.gameKey && c.gameKey !== ctx.gameKey) return false;

  switch (c.type) {
    case "first_event":
      return true;
    case "threshold": {
      const raw = ctx.payload[c.field];
      const num = typeof raw === "number" ? raw : Number(raw);
      if (Number.isNaN(num)) return false;
      switch (c.op) {
        case ">=":
          return num >= c.value;
        case ">":
          return num > c.value;
        case "<=":
          return num <= c.value;
        case "<":
          return num < c.value;
        case "==":
          return num === c.value;
      }
      return false;
    }
    default:
      return false;
  }
}
