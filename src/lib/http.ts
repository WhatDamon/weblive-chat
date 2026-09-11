import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { MAX_ID_BOUND } from "./history";

export const codes = {
  invalid_body: "请求体缺失或不是 JSON",
  invalid_uuid: "client_id 必须是合法 UUID",
  invalid_cursor: "游标 id 必须是正整数",
  nick_empty: "昵称不能为空",
  nick_too_long: "昵称超长",
  text_empty: "内容不能为空",
  text_too_long: "内容超长",
  banned_word: "内容含违禁词",
  banned: "该 IP 已被禁言",
  rate_limited: "请求过于频繁",
  origin_not_allowed: "来源不被允许",
  missing_origin: "缺少 Origin 来源",
  unauthorized: "未登录或会话失效",
  invalid_secret: "管理口令错误",
  invalid_confirm: "确认短语不匹配",
  invalid_token: "预检令牌无效、已过期或已被使用",
  not_found: "资源不存在",
  db_unavailable: "数据库暂不可用",
} as const;
export type ErrCode = keyof typeof codes;

export function jsonError(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrCode,
  extra?: { message?: string; retry_after_ms?: number; reason?: string },
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
  // 上界夹取到 MAX_ID_BOUND（PG messages/events.id = serial/int4）：超大用户游标不得直入 `id < ?`（PG 执行期 out of range）
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_ID_BOUND) : null;
}
