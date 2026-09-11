import { signToken, verifyToken } from "./security";

/**
 * 危险操作（清空数据）的校验核心：档位、逐字确认短语、一次性令牌。
 * 纯函数，无 IO —— 便于单测；路由只负责编排（会话 → 限流 → 短语 → 口令 → 令牌 → 执行）。
 */

export type PurgeScope = "chat" | "full";

/** 各表物理行数（与表名同名，避免 API 层再映射一次）。 */
export interface PurgeCounts {
  messages: number;
  events: number;
  presence: number;
  rate_limits: number;
  bans: number;
}

/** 可清空的表 = 计数键，二者不可能漂移。 */
export type PurgeTable = keyof PurgeCounts;

/** 全部可清空的表（固定顺序）：计数遍历、UI 展示与“保留哪些表”都从此派生。 */
export const PURGE_ALL_TABLES: readonly PurgeTable[] = [
  "messages",
  "events",
  "presence",
  "rate_limits",
  "bans",
];

/** 各档位涉及的表（白名单，绝不接受调用方传入的任意表名）。 */
export const PURGE_TABLES: Record<PurgeScope, readonly PurgeTable[]> = {
  chat: ["messages", "events"],
  full: ["messages", "events", "presence", "rate_limits", "bans"],
};

/** 逐字确认短语：服务端与后台 UI 共用同一来源，避免两边措辞漂移。 */
export const PURGE_PHRASES: Record<PurgeScope, string> = {
  chat: "清空聊天记录",
  full: "清空全部数据",
};

/** 档位说明（管理接口原样回给 UI 展示）。 */
export const PURGE_SCOPE_DESC: Record<PurgeScope, string> = {
  chat: "清空聊天数据（消息与事件），保留封禁名单、在线状态与限流计数",
  full: "清空全部数据（消息、事件、在线状态、限流计数、封禁名单），相当于恢复出厂",
};

/** 预检令牌有效期：预检与执行之间允许的最大间隔。 */
export const PURGE_TOKEN_TTL_MS = 60_000;

export function isPurgeScope(v: unknown): v is PurgeScope {
  return v === "chat" || v === "full";
}

/** 逐字确认：仅容忍首尾空白（移动端键盘易带空格），中间任何差异都算不匹配。 */
export function purgePhraseMatches(scope: PurgeScope, input: unknown): boolean {
  return typeof input === "string" && input.trim() === PURGE_PHRASES[scope];
}

export type PurgeTokenReason =
  | "invalid_token"
  | "token_scope"
  | "token_ip";

export type PurgeTokenVerdict =
  | { ok: true; nonce: string }
  | { ok: false; reason: PurgeTokenReason };

/** 签发一次性令牌：绑定档位与发起 IP，60s 过期；nonce 供服务端做「单次使用」记账。 */
export function mintPurgeToken(
  o: { scope: PurgeScope; ip: string },
  secret: string,
  now: number = Date.now(),
): { token: string; expiresAt: number; nonce: string } {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const expiresAt = now + PURGE_TOKEN_TTL_MS;
  const token = signToken(
    { sub: "purge", scope: o.scope, ip: o.ip, nonce, exp: expiresAt },
    secret,
  );
  return { token, expiresAt, nonce };
}

/**
 * 校验令牌。签名与有效期由 verifyToken 把关（任一不满足 → invalid_token，
 * 不区分「被篡改」与「已过期」，避免给探测者额外信息）；随后再核对档位与 IP。
 */
export function verifyPurgeToken(
  token: string | undefined,
  o: { scope: PurgeScope; ip: string },
  secret: string,
): PurgeTokenVerdict {
  const p = verifyToken(token, secret);
  if (!p || p.sub !== "purge" || typeof p.nonce !== "string")
    return { ok: false, reason: "invalid_token" };
  if (p.scope !== o.scope) return { ok: false, reason: "token_scope" };
  if (p.ip !== o.ip) return { ok: false, reason: "token_ip" };
  return { ok: true, nonce: p.nonce };
}
