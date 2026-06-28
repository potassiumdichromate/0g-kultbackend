import { z } from "zod";

// Mirrors GET /auth/nonce and POST /auth/login from both existing repos exactly,
// so the API Gateway's identity routes are a familiar shape to any existing game client.
export const NonceRequestQuerySchema = z.object({
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

export const NonceResponseSchema = z.object({
  wallet: z.string(),
  nonce: z.string(),
  issuedAt: z.string(),
  message: z.string(),
  expiresIn: z.number(),
});

export const LoginRequestBodySchema = z.object({
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  signature: z.string(),
  nonce: z.string(),
});

export const LoginResponseSchema = z.object({
  token: z.string(),
  wallet: z.string(),
  expiresIn: z.number(),
  tokenType: z.literal("Bearer"),
});

export type NonceResponse = z.infer<typeof NonceResponseSchema>;
export type LoginRequestBody = z.infer<typeof LoginRequestBodySchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
