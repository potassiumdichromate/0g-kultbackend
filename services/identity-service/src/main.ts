import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { PrismaClient } from "@platform/db";
import { createRedisClient, createLogger } from "@platform/utils";
import { createAuthRouter } from "./auth.routes";

const logger = createLogger("identity-service");
const PORT = Number(process.env.IDENTITY_SERVICE_PORT || 3001);
const JWT_SECRET = process.env.PLATFORM_JWT_SECRET || "dev-secret-change-me";

if (JWT_SECRET === "dev-secret-change-me") {
  logger.warn("PLATFORM_JWT_SECRET is unset — using an insecure dev default. Do not run this in production.");
}

const redis = createRedisClient(process.env.REDIS_URL || "redis://localhost:6379");
const prisma = new PrismaClient();

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "identity-service" }));

app.use(
  "/auth",
  rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false }),
  createAuthRouter(redis, prisma, JWT_SECRET),
);

app.listen(PORT, () => {
  logger.info(`identity-service listening on :${PORT}`);
});

process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
