import { Router } from "express";
import type { Redis } from "ioredis";
import { ethers } from "ethers";
import { randomUUID } from "node:crypto";
import { PrismaClient, Prisma } from "@platform/db";
import { RedisKeys, issuePlatformJwt, looksLikeRawWalletAddress, getOrCreateUser } from "@platform/utils";
import { NonceRequestQuerySchema, LoginRequestBodySchema } from "@platform/dto";

const NONCE_TTL_SECONDS = 300;
const WALLET_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * Faithfully reproduces the nonce -> sign -> verify -> JWT flow from
 * zerodash-0g-backend/src/controllers/authController.js and
 * warzone-backend-0g/src/controllers/authController.js (the two were already identical
 * except for the product name in the signed message). Nonce storage moves from a Mongo
 * TTL-indexed collection to a Redis key with a TTL — same single-use, 5-minute-expiry
 * guarantee, no extra database needed for what is fundamentally ephemeral state.
 *
 * Round 3: every nonce-replay attempt, signature failure, and successful login is logged to
 * SecurityAuditLog SYNCHRONOUSLY (not via NATS — see architecture/09-security-model.md §7).
 * This was previously designed but unwired; closing that gap is what "do it" meant for this
 * service specifically.
 */
async function logSecurityEvent(
  prisma: PrismaClient,
  eventType: string,
  detail: Record<string, unknown>,
  userId?: string,
) {
  await prisma.securityAuditLog.create({
    data: { eventType, detail: detail as Prisma.InputJsonValue, userId },
  });
}

export function createAuthRouter(redis: Redis, prisma: PrismaClient, jwtSecret: string) {
  const router = Router();

  router.get("/nonce", async (req, res) => {
    const parsed = NonceRequestQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid or missing wallet address" });
    }
    const wallet = parsed.data.wallet.toLowerCase();
    const nonce = randomUUID().replace(/-/g, "");
    const issuedAt = new Date().toISOString();

    await redis.set(RedisKeys.nonce(wallet), JSON.stringify({ nonce, issuedAt }), "EX", NONCE_TTL_SECONDS);

    const message =
      `Sign in to the Kult Browser platform\n\n` +
      `Wallet: ${wallet}\n` +
      `Nonce: ${nonce}\n` +
      `Issued At: ${issuedAt}\n\n` +
      `Signing this message grants access to your unified platform profile.\n` +
      `It will not trigger a blockchain transaction or cost gas fees.`;

    return res.status(200).json({ wallet, nonce, issuedAt, message, expiresIn: NONCE_TTL_SECONDS });
  });

  router.post("/login", async (req, res) => {
    const parsed = LoginRequestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "wallet, signature, and nonce are required" });
    }
    const { wallet, signature, nonce } = parsed.data;
    const walletLower = wallet.toLowerCase();

    const stored = await redis.get(RedisKeys.nonce(walletLower));
    if (!stored) {
      await logSecurityEvent(prisma, "NONCE_INVALID_OR_EXPIRED", { walletAddress: walletLower });
      return res.status(401).json({
        error: "Invalid or expired nonce.",
        hint: "Request a fresh nonce via GET /auth/nonce?wallet=<address>",
      });
    }
    await redis.del(RedisKeys.nonce(walletLower)); // single-use, regardless of outcome

    const { nonce: storedNonce, issuedAt } = JSON.parse(stored) as { nonce: string; issuedAt: string };
    if (storedNonce !== nonce) {
      await logSecurityEvent(prisma, "NONCE_MISMATCH", { walletAddress: walletLower });
      return res.status(401).json({ error: "Nonce mismatch" });
    }

    const message =
      `Sign in to the Kult Browser platform\n\n` +
      `Wallet: ${walletLower}\n` +
      `Nonce: ${storedNonce}\n` +
      `Issued At: ${issuedAt}\n\n` +
      `Signing this message grants access to your unified platform profile.\n` +
      `It will not trigger a blockchain transaction or cost gas fees.`;

    let recovered: string;
    try {
      recovered = ethers.verifyMessage(message, signature);
    } catch {
      await logSecurityEvent(prisma, "SIGNATURE_VERIFICATION_FAILED", { walletAddress: walletLower });
      return res.status(401).json({ error: "Signature verification failed" });
    }

    if (recovered.toLowerCase() !== walletLower) {
      await logSecurityEvent(prisma, "SIGNATURE_WALLET_MISMATCH", {
        claimedWallet: walletLower,
        recoveredWallet: recovered.toLowerCase(),
      });
      return res.status(401).json({ error: "Signature does not match wallet" });
    }

    // Table ownership per shared/db/prisma/schema.prisma: identity-service creates User rows.
    const user = await getOrCreateUser(prisma, walletLower);
    await logSecurityEvent(prisma, "LOGIN_SUCCESS", { walletAddress: walletLower }, user.id);

    const token = issuePlatformJwt(walletLower, jwtSecret, "7d");
    return res.status(200).json({ token, wallet: walletLower, expiresIn: 7 * 24 * 60 * 60, tokenType: "Bearer" });
  });

  return router;
}

export function isRawWalletToken(token: string): boolean {
  return looksLikeRawWalletAddress(token) || WALLET_PATTERN.test(token);
}
