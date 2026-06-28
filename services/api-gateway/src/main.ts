import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { createProxyMiddleware } from "http-proxy-middleware";
import { createLogger } from "@platform/utils";
import { requireAuth } from "./auth.guard";
import { createGameProxyRouter } from "./game-proxy";

const logger = createLogger("api-gateway");
const PORT = Number(process.env.API_GATEWAY_PORT || 3000);
const JWT_SECRET = process.env.PLATFORM_JWT_SECRET || "dev-secret-change-me";

const SERVICES = {
  identity: `http://localhost:${process.env.IDENTITY_SERVICE_PORT || 3001}`,
  profile: `http://localhost:${process.env.PROFILE_SERVICE_PORT || 3002}`,
  leaderboard: `http://localhost:${process.env.LEADERBOARD_SERVICE_PORT || 3003}`,
  achievement: `http://localhost:${process.env.ACHIEVEMENT_SERVICE_PORT || 3004}`,
  reward: `http://localhost:${process.env.REWARD_SERVICE_PORT || 3005}`,
};

// Existing, unmodified game backends — passthrough only. Adding a 101st game here is a
// one-line addition, never a redeploy of the games themselves.
const GAME_BACKENDS: Record<string, string> = {
  zerodash: process.env.ZERODASH_BACKEND_URL || "https://zerog-zerodash.onrender.com",
  warzone: process.env.WARZONE_BACKEND_URL || "https://warzone-backend-0g.onrender.com",
};

const app = express();
app.use(cors());
app.use(rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));

app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "api-gateway" }));

// Public: SIWE nonce/login passthrough to identity-service.
app.use("/api/v1/auth", createProxyMiddleware({ target: SERVICES.identity, changeOrigin: true, pathRewrite: { "^/api/v1/auth": "/auth" } }));

// Public reads.
app.use("/api/v1/leaderboard", createProxyMiddleware({ target: SERVICES.leaderboard, changeOrigin: true, pathRewrite: { "^/api/v1/leaderboard": "/leaderboard" } }));
app.use("/api/v1/achievements", createProxyMiddleware({ target: SERVICES.achievement, changeOrigin: true, pathRewrite: { "^/api/v1/achievements": "/achievements" } }));

// Authenticated platform endpoints.
app.use(
  "/api/v1/profile",
  requireAuth(JWT_SECRET),
  createProxyMiddleware({ target: SERVICES.profile, changeOrigin: true, pathRewrite: { "^/api/v1/profile": "/profile" } }),
);
app.use(
  "/api/v1/rewards",
  requireAuth(JWT_SECRET),
  createProxyMiddleware({ target: SERVICES.reward, changeOrigin: true, pathRewrite: { "^/api/v1/rewards": "/rewards" } }),
);

// Pure passthrough to the real, unmodified game backends (their own auth still applies).
app.use("/api/v1/games", createGameProxyRouter(GAME_BACKENDS));

app.listen(PORT, () => {
  logger.info(`api-gateway listening on :${PORT}`);
});
