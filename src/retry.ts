import { config } from "./config.js";

interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (error: unknown, attempt: number) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = config.retry.maxAttempts,
    baseDelayMs = config.retry.baseDelayMs,
    maxDelayMs = config.retry.maxDelayMs,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;

      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 1000,
        maxDelayMs
      );

      onRetry?.(error, attempt);
      console.log(
        `[retry] Attempt ${attempt}/${maxAttempts} failed, retrying in ${Math.round(delay)}ms...`
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
