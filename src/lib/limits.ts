export interface RateSink {
  rateHit(bucket: string, scope: string, windowStart: number): Promise<number>;
}

/** 60s fixed window; book counters via windowStartFor so they land in the same window. */
const RATE_WINDOW_MS = 60_000;

export function windowStartFor(now: number = Date.now()): number {
  return Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
}

export async function rateCheck(
  repo: RateSink,
  bucket: string,
  scope: string,
  limitPerMin: number,
  now: number = Date.now(),
): Promise<{ allowed: boolean; count: number; retryAfterMs: number }> {
  const windowStart = windowStartFor(now);
  const count = await repo.rateHit(bucket, scope, windowStart);
  const allowed = count <= limitPerMin;
  return { allowed, count, retryAfterMs: windowStart + RATE_WINDOW_MS - now };
}
