import type { RouterFallbackMode } from "@ccr/core/contracts/app";
import { classifyRouteFailure } from "@ccr/core/routing/failure-classifier";
import { clampNumber } from "@ccr/core/gateway/internal/collections";

const upstreamRetryBackoffBaseMs = 1_000;
const upstreamRetryBackoffMaxMs = 30_000;
const upstreamRetryAfterMaxMs = 60_000;
const rateLimitWaitBaseMs = 1_000;
const rateLimitWaitMaxMs = 15_000;

/**
 * How long to hold a client request before re-attempting after a 429, once the
 * plan's own attempts are exhausted. Returns undefined when the budget is spent
 * (or the next wait would overrun it) and the 429 should surface to the client.
 */
export function rateLimitRetryWaitMs(input: {
  attemptIndex: number;
  elapsedMs: number;
  retryAfterHeader?: string | null;
  waitBudgetMs: number;
}): number | undefined {
  if (!Number.isFinite(input.waitBudgetMs) || input.waitBudgetMs <= 0) {
    return undefined;
  }
  const remainingMs = input.waitBudgetMs - input.elapsedMs;
  if (remainingMs <= 0) {
    return undefined;
  }
  const retryAfterMs = parseRetryAfterHeaderMs(input.retryAfterHeader ?? null);
  const waitMs = retryAfterMs !== undefined && retryAfterMs > 0
    ? clampNumber(retryAfterMs, rateLimitWaitBaseMs, upstreamRetryAfterMaxMs)
    : Math.min(rateLimitWaitMaxMs, rateLimitWaitBaseMs * 2 ** Math.min(10, Math.max(0, input.attemptIndex)));
  if (waitMs > remainingMs) {
    return undefined;
  }
  return waitMs;
}

export function rateLimitRetryWaitMsForTest(input: {
  attemptIndex: number;
  elapsedMs: number;
  retryAfterHeader?: string | null;
  waitBudgetMs: number;
}): number | undefined {
  return rateLimitRetryWaitMs(input);
}

export function shouldFallbackAfterStatus(statusCode: number, mode: RouterFallbackMode): boolean {
  return classifyRouteFailure(statusCode, mode).shouldFallback;
}

export function retryDelayAfterStatus(headers: Headers, failedAttemptIndex: number): number {
  const retryAfterMs = parseRetryAfterHeaderMs(headers.get("retry-after"));
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return clampNumber(retryAfterMs, 1, upstreamRetryAfterMaxMs);
  }
  return exponentialRetryBackoffMs(failedAttemptIndex);
}

export function retryDelayAfterNetworkError(failedAttemptIndex: number): number {
  return exponentialRetryBackoffMs(failedAttemptIndex);
}

export function fallbackRetryDelayAfterStatusForTest(input: {
  failedAttemptIndex?: number;
  retryAfter?: string | null;
  statusCode: number;
}): number {
  const headers = new Headers();
  if (input.retryAfter !== undefined && input.retryAfter !== null) {
    headers.set("retry-after", input.retryAfter);
  }
  return retryDelayAfterStatus(headers, input.failedAttemptIndex ?? 0);
}

export function fallbackRetryDelayAfterNetworkErrorForTest(failedAttemptIndex = 0): number {
  return retryDelayAfterNetworkError(failedAttemptIndex);
}

function parseRetryAfterHeaderMs(value: string | null): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const retryAt = Date.parse(trimmed);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : undefined;
}

function exponentialRetryBackoffMs(failedAttemptIndex: number): number {
  const exponent = Math.min(10, Math.max(0, failedAttemptIndex));
  return Math.min(upstreamRetryBackoffMaxMs, upstreamRetryBackoffBaseMs * 2 ** exponent);
}
