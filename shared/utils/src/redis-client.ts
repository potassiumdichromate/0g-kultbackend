import Redis from "ioredis";

/** Key namespace conventions — see architecture/06-redis-strategy.md for the full list. */
export const RedisKeys = {
  session: (walletAddress: string) => `session:${walletAddress.toLowerCase()}`,
  nonce: (walletAddress: string) => `auth:nonce:${walletAddress.toLowerCase()}`,
  profileCache: (walletAddress: string) => `cache:profile:${walletAddress.toLowerCase()}`,
  rootHashCache: (walletAddress: string, gameKey: string) =>
    `cache:roothash:${gameKey}:${walletAddress.toLowerCase()}`,
  /** save-service's fast working copy of the decoded JSON save — never the source of truth, see architecture/03-database-diagram.md. */
  savedGameCache: (gameKey: string, walletAddress: string) =>
    `cache:save:${gameKey}:${walletAddress.toLowerCase()}`,
  onlinePlayers: (gameKey: string) => `online:${gameKey}`,
  leaderboard: (gameKey: string, metric: string) => `leaderboard:${gameKey}:${metric}`,
  globalLeaderboard: (metric: string) => `leaderboard:global:${metric}`,
  matchmakingQueue: (gameKey: string) => `matchmaking:${gameKey}`,
};

export function createRedisClient(redisUrl: string): Redis {
  return new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
}
