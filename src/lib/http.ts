import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { MAX_ID_BOUND } from "./history";

import { COPY } from "./copy";
import { incMetric } from "./metrics";
import { logError } from "./log";

export const codes = COPY.error;
export type ErrCode = keyof typeof codes;

/** Hono 的 Variables 需要显式声明，否则 c.set/c.get 在 strict 下无法通过类型检查。 */
export type AppEnv = { Variables: { requestId: string } };

export function getRequestId(c: Context<AppEnv>): string {
  return c.get("requestId") ?? "unknown";
}

export function jsonError(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  code: ErrCode,
  extra?: {
    message?: string;
    retry_after_ms?: number;
    reason?: string;
    origin?: string;
    allowed_origins_count?: number;
  },
) {
  return c.json(
    {
      error: {
        code,
        message: extra?.message ?? codes[code],
        ...(extra?.retry_after_ms !== undefined
          ? { retry_after_ms: extra.retry_after_ms }
          : {}),
        ...(extra?.reason !== undefined ? { reason: extra.reason } : {}),
        // Echo the received origin and allowlist size, or the 403 cannot be diagnosed.
        ...(extra?.origin !== undefined ? { origin: extra.origin } : {}),
        ...(extra?.allowed_origins_count !== undefined
          ? { allowed_origins_count: extra.allowed_origins_count }
          : {}),
      },
    },
    status,
  );
}

/** 存储故障的统一出口：计数 + 结构化日志 + 503 信封（客户端看不到内部原因）。 */
export function failDb(c: Context<AppEnv>, scope: string, err: unknown) {
  incMetric("dbErrors");
  logError(scope, err, { request_id: getRequestId(c) });
  return jsonError(c, 503, "db_unavailable");
}

export async function readJson(
  c: Context<AppEnv>,
): Promise<Record<string, unknown> | null> {
  const ct = c.req.header("content-type") ?? "";
  if (!ct.includes("application/json")) return null;
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** 游标 0 是合法的「从最早开始」；before 仍然要求 >= 1（见 parseIdParam）。 */
export function parseSinceParam(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? Math.min(n, MAX_ID_BOUND) : null;
}

export function parseIdParam(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  // Clamp to MAX_ID_BOUND: PG serial columns overflow on larger ids at execution time.
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_ID_BOUND) : null;
}
