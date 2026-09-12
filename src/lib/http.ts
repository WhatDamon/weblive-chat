import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { MAX_ID_BOUND } from "./history";

import { COPY } from "./copy";

export const codes = COPY.error;
export type ErrCode = keyof typeof codes;

export function jsonError(
  c: Context,
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

export async function readJson(
  c: Context,
): Promise<Record<string, unknown> | null> {
  const ct = c.req.header("content-type") ?? "";
  if (!ct.includes("application/json")) return null;
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export function parseIdParam(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  // Clamp to MAX_ID_BOUND: PG serial columns overflow on larger ids at execution time.
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_ID_BOUND) : null;
}
