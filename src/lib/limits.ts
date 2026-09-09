export interface RateSink {
  rateHit(bucket: string, scope: string, windowStart: number): Promise<number>;
}

export async function rateCheck(
  repo: RateSink,
  bucket: string,
  scope: string,
  limitPerMin: number,
  now: number = Date.now(),
): Promise<{ allowed: boolean; count: number; retryAfterMs: number }> {
  const windowMs = 60_000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const count = await repo.rateHit(bucket, scope, windowStart);
  const allowed = count <= limitPerMin;
  return { allowed, count, retryAfterMs: windowStart + windowMs - now };
}
