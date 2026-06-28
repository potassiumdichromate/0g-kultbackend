import jwt from "jsonwebtoken";

/**
 * Mirrors the exact claim shape used today by both repos
 * (zerodash-0g-backend/src/controllers/authController.js and
 *  warzone-backend-0g/src/middleware/auth.js): { walletAddress, sub }, HS256, 7-day expiry.
 *
 * This means identity-service is a drop-in replacement: point a game's BROWSER_JWT_SECRET
 * env var at PLATFORM_JWT_SECRET and its existing auth middleware keeps working unmodified.
 */
export interface PlatformJwtClaims {
  walletAddress: string;
  sub: string;
}

export function issuePlatformJwt(
  walletAddress: string,
  secret: string,
  expiresIn: jwt.SignOptions["expiresIn"] = "7d",
): string {
  const claims: PlatformJwtClaims = {
    walletAddress: walletAddress.toLowerCase(),
    sub: walletAddress.toLowerCase(),
  };
  return jwt.sign(claims, secret, { algorithm: "HS256", expiresIn });
}

export function verifyPlatformJwt(token: string, secret: string): PlatformJwtClaims {
  const payload = jwt.verify(token, secret, { algorithms: ["HS256"] }) as Record<string, unknown>;
  const walletAddress =
    (payload.walletAddress as string) ||
    (payload.wallet as string) ||
    (payload.address as string) ||
    (payload.sub as string);

  if (!walletAddress) {
    throw new Error("Token does not contain a wallet claim");
  }
  return { walletAddress: walletAddress.toLowerCase(), sub: walletAddress.toLowerCase() };
}

const RAW_WALLET_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** Same defensive check both repos already have: never accept a raw address as a bearer token. */
export function looksLikeRawWalletAddress(token: string): boolean {
  return RAW_WALLET_PATTERN.test(token);
}
