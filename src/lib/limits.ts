export interface RateSink {
  rateHit(bucket: string, scope: string, windowStart: number): Promise<number>;
}

/** 固定窗口宽度：60s 对齐窗口（外部构造同窗口记账时请用 windowStartFor）。 */
const RATE_WINDOW_MS = 60_000;

/** 当前所在窗口的起点（epoch 对齐）；复用同一取整逻辑，避免各处各写一套。 */
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
