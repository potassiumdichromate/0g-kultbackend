import type { Request, Response, NextFunction } from "express";
import { verifyPlatformJwt, looksLikeRawWalletAddress } from "@platform/utils";

export interface AuthedRequest extends Request {
  walletAddress?: string;
}

/**
 * Same guard as services/api-gateway/src/auth.guard.ts — save-service sits behind the
 * gateway in production but must never trust a wallet address coming from anywhere except
 * a verified JWT (this is the literal fix for the DevTools-tampering class of bug: a
 * client could otherwise PATCH a request body's "walletAddress" field and write to/read
 * from someone else's save).
 */
export function requireAuth(jwtSecret: string) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const token = header.slice("Bearer ".length).trim();

    if (looksLikeRawWalletAddress(token)) {
      return res.status(401).json({ error: "Raw wallet address is not a valid token" });
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
