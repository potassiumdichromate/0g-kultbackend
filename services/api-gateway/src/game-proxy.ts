import { Router } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

/**
 * THIS is what "keep the save/load system intact" means at the gateway layer: requests to
 * /api/v1/games/:gameKey/* are forwarded byte-for-byte (including the binary save/load
 * routes, Authorization header, and X-Save-Index/X-Root-Hash headers) to the real,
 * unmodified ZeroDash/Warzone backend. The gateway adds nothing and removes nothing from
 * that path — it's a pure passthrough so Unity clients can eventually point at one origin
 * without either backend changing a single line.
 */
export function createGameProxyRouter(gameBackends: Record<string, string>): Router {
  const router = Router();

  for (const [gameKey, backendBaseUrl] of Object.entries(gameBackends)) {
    router.use(
      `/${gameKey}`,
      createProxyMiddleware({
        target: backendBaseUrl,
        changeOrigin: true,
        pathRewrite: { [`^/${gameKey}`]: "" },
        on: {
          error: (err, _req, res) => {
            (res as import("http").ServerResponse).writeHead(502, { "Content-Type": "application/json" });
            (res as import("http").ServerResponse).end(
              JSON.stringify({ error: `Upstream game backend (${gameKey}) unreachable`, detail: err.message }),
            );
          },
        },
      }),
    );
  }

  return router;
}
