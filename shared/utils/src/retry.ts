/**
 * Ported from the `withRetry` pattern duplicated in both zerodash-0g-backend/src/utils/retry.js
 * and warzone-backend-0g/src/utils/retry.js. Identical logic in both repos — a textbook case
 * of code that should live in one shared place instead of being copy-pasted per game.
 */
export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  label?: string;
  onAttemptFailed?: (attempt: number, maxAttempts: number, error: unknown) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 4000, label = "operation", onAttemptFailed } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      onAttemptFailed?.(attempt, maxAttempts, error);
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }
  }
  throw new Error(
    `${label} failed after ${maxAttempts} attempts: ${(lastError as Error)?.message ?? lastError}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
