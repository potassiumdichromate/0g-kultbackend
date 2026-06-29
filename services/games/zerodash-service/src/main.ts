import express from "express";
import cors from "cors";
import { createLogger } from "@platform/utils";
import { requireAuth } from "./auth";
import { createSaveRouter } from "./save.routes";

const logger = createLogger("zerodash-service");
const PORT = Number(process.env.ZERODASH_SERVICE_PORT || 3011);
const JWT_SECRET = process.env.PLATFORM_JWT_SECRET || "dev-secret-change-me";
const SAVE_SERVICE_URL = process.env.SAVE_SERVICE_URL || "http://localhost:3008";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "zerodash-service" }));

app.use("/save", requireAuth(JWT_SECRET), createSaveRouter(SAVE_SERVICE_URL));

app.listen(PORT, () => logger.info(`zerodash-service listening on :${PORT}`));
