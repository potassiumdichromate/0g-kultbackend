import type { Request, Response, NextFunction } from "express";
import { verifyPlatformJwt, looksLikeRawWalletAddress } from "@platform/utils";

export interface AuthedRequest extends Request {
  walletAddress?: string;
}

/**
 * Same contract as the auth middleware duplicated in both existing repos
 * (src/middleware/auth.js): Bearer JWT in, req.walletAddress out, raw wallet
 * addresses explicitly rejected as a defense against clients skipping the
 * signature step entirely.
 */
export function requireAuth(jwtSecret: string) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const token = header.slice("Bearer ".length).trim();

    if (looksLikeRawWalletAddress(token)) {
      return res.status(401).json({
        error: "Raw wallet address is not a valid token",
        hint: "Complete the SIWE flow via /api/v1/auth/nonce and /api/v1/auth/login",
      });
    }

    try {
      const claims = verifyPlatformJwt(token, jwtSecret);
      req.walletAddress = claims.walletAddress;
      next();
    } catch {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  };
}
