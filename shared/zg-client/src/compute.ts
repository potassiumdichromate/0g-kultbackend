import type { Logger } from "pino";

export interface AntiCheatVerdict {
  verdict: "CLEAN" | "SUSPICIOUS" | "SKIPPED";
  confidence?: number;
  flags?: string[];
  teeVerified?: boolean;
  providerAddress?: string;
  chatId?: string;
  billingCost?: number;
}

export interface AntiCheatInput {
  rootHash: string;
  saveIndex: number;
  prevSaveIndex: number;
  coinDelta: number;
  timeElapsedMs: number;
  /** Game-specific save JSON — same payload save-service validated and is about to encode. */
  saveData: unknown;
}

/**
 * Ported from the anti-cheat half of ZeroGCompute.js (duplicated, with only the system
 * prompt differing, in zerodash-0g-backend/src/services/ZeroGCompute.js and
 * warzone-backend-0g/src/services/ZeroGCompute.js). Same OpenAI-compatible call to the 0G
 * Compute router, same rootHash-echo binding check (rejects a response that doesn't echo
 * the input rootHash back — prevents a stale/replayed verdict being attached to this save),
 * same graceful skip when no API key is configured.
 */
export interface ComputeClientOptions {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  logger?: Logger;
}

export function createComputeClient(opts: ComputeClientOptions = {}) {
  const apiKey = opts.apiKey ?? process.env.ZG_COMPUTE_API_KEY;
  const endpoint = opts.endpoint ?? "https://router-api.0g.ai/v1/chat/completions";
  const model = opts.model ?? "0GM-1.0-35B-A3B";

  const isConfigured = Boolean(apiKey);

  async function runAntiCheat(input: AntiCheatInput, systemPrompt: string): Promise<AntiCheatVerdict> {
    if (!isConfigured) {
      opts.logger?.info("zg-client/compute: ZG_COMPUTE_API_KEY not set — anti-cheat skipped");
      return { verdict: "SKIPPED" };
    }

    const userMessage = JSON.stringify({
      saveIndex: input.saveIndex,
      prevSaveIndex: input.prevSaveIndex,
      coinDelta: input.coinDelta,
      timeElapsed: input.timeElapsedMs,
      saveData: input.saveData,
      rootHash: input.rootHash,
    });

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      throw new Error(`0G Compute request failed: HTTP ${res.status}`);
    }

    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      x_0g_trace?: { tee_verified?: boolean; provider?: string; billing?: { total_cost?: number } };
      id?: string;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("0G Compute response had no message content");
    }

    const parsed = JSON.parse(content) as { verdict?: string; confidence?: number; flags?: string[]; rootHash?: string };

    // Binding check: the verdict must echo back the exact rootHash we sent, or it could be
    // a stale/cached/replayed response being misattributed to this save.
    if (parsed.rootHash !== input.rootHash) {
      throw new Error("0G Compute response rootHash binding check failed");
    }

    return {
      verdict: parsed.verdict === "SUSPICIOUS" ? "SUSPICIOUS" : "CLEAN",
      confidence: parsed.confidence,
      flags: parsed.flags,
      teeVerified: body.x_0g_trace?.tee_verified,
      providerAddress: body.x_0g_trace?.provider,
      chatId: body.id,
      billingCost: body.x_0g_trace?.billing?.total_cost,
    };
  }

  return { isConfigured, runAntiCheat };
}

export type ComputeClient = ReturnType<typeof createComputeClient>;
