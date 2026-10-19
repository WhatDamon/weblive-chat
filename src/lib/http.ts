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

export const MAX_BODY_BYTES = 16_384;

/** 边读边计数：越限立即取消流，不把超限的字节留在内存里。 */
async function readCappedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string } | { tooLarge: true }> {
  if (!body) return { text: "" };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      out += decoder.decode(value, { stream: true });
    }
  } catch {
    return { text: out };
  }
  return { text: out + decoder.decode() };
}

export type JsonBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; tooLarge: boolean };

/** 先看 content-length，再按字节数兜底：避免把任意大的 body 解析成对象。 */
export async function readJsonBody(
  c: Context<AppEnv>,
  maxBytes = MAX_BODY_BYTES,
): Promise<JsonBodyResult> {
  const ct = c.req.header("content-type") ?? "";
  if (!ct.includes("application/json")) return { ok: false, tooLarge: false };
  const rawLen = c.req.header("content-length");
  // 缺席必须是 NaN（不是 0）：否则没带 content-length 的 chunked 请求会走快路径。
  const len = rawLen === undefined ? Number.NaN : Number(rawLen);
  if (Number.isFinite(len) && len > maxBytes)
    return { ok: false, tooLarge: true };
  // 已知且不超限：直接读文本（零风险的最快路径）。否则按字节数边读边限，
  // 否则一个 1GB 的 chunked body 会先把内存吃光再被拒。
  let text: string;
  if (Number.isFinite(len)) {
    try {
      text = await c.req.text();
    } catch {
      // 读体失败的语义是「不是合法 JSON」，不是「太大」。
      return { ok: false, tooLarge: false };
    }
    if (new TextEncoder().encode(text).length > maxBytes)
      return { ok: false, tooLarge: true };
  } else {
    const capped = await readCappedText(c.req.raw.body, maxBytes);
    if ("tooLarge" in capped) return { ok: false, tooLarge: true };
    text = capped.text;
  }
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v))
      return { ok: false, tooLarge: false };
    return { ok: true, body: v as Record<string, unknown> };
  } catch {
    return { ok: false, tooLarge: false };
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
