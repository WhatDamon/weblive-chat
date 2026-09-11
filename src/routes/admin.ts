import type { Context, Hono, Next } from "hono";
import type { AppConfig } from "../lib/config";
import type { Repo } from "../lib/repo";
import type { HistoryMode } from "../lib/history";
import {
  signToken,
  verifyToken,
  clientIpFromHeaders,
  normalizeIp,
} from "../lib/security";
import { rateCheck, windowStartFor } from "../lib/limits";
import { jsonError, readJson, parseIdParam } from "../lib/http";
import {
  PURGE_ALL_TABLES,
  PURGE_PHRASES,
  PURGE_SCOPE_DESC,
  PURGE_TABLES,
  isPurgeScope,
  mintPurgeToken,
  purgePhraseMatches,
  verifyPurgeToken,
  type PurgeTokenReason,
} from "../lib/purge";

export interface AdminDeps {
  cfg: AppConfig;
  repo: Repo;
  history: { retentionDays: number; mode: HistoryMode };
  /** 每次写后由调用方调用的维护触发；stats 借其刷新档位后回报 */
  maintain: (
    now?: number,
  ) => Promise<{ mode: HistoryMode; retentionDays: number }>;
}

const COOKIE_FLAGS = "HttpOnly; SameSite=Lax; Path=/";

/** 令牌校验失败原因 → 给操作者的可操作提示（仅管理端可见，不含任何敏感值）。 */
const PURGE_TOKEN_MSG: Record<PurgeTokenReason, string> = {
  invalid_token: "预检令牌无效或已过期，请重新预检",
  token_scope: "预检令牌与当前档位不符，请重新预检",
  token_ip: "预检令牌与发起 IP 不符，请重新预检",
};
export function cookieHeader(
  cfg: AppConfig,
  token: string,
  maxAgeSec: number,
): string {
  // Cookie 安全：Secure 仅生产（本地 http 不设，避免被浏览器忽略）；
  // SameSite=Lax + HttpOnly 恒定。
  const secure = cfg.env === "production" ? "; Secure" : "";
  return `${cfg.cookieName}=${token}; Max-Age=${maxAgeSec}; ${COOKIE_FLAGS}${secure}`;
}

export function registerAdmin(app: Hono, d: AdminDeps) {
  const { cfg, repo } = d;

  const ipOf = (c: Context) =>
    clientIpFromHeaders(
      { "x-forwarded-for": c.req.header("x-forwarded-for") },
      cfg.devIp,
    );

  app.post("/api/admin/login", async (c) => {
    const ip = ipOf(c);
    // 登录限流先行：错误口令也计入（防爆破）；DB 故障时不可达 rateCheck → 503
    try {
      const rl = await rateCheck(repo, "login", ip, cfg.rate.loginPerMin);
      if (!rl.allowed)
        return jsonError(c, 429, "rate_limited", {
          retry_after_ms: rl.retryAfterMs,
        });
    } catch {
      return jsonError(c, 503, "db_unavailable");
    }
    const body = await readJson(c);
    const given = (body as { secret?: unknown } | null)?.secret;
    if (typeof given !== "string" || given.length === 0)
      return jsonError(c, 400, "invalid_body");
    // 恒时比较由 verifyToken 侧保证（登录仅比对字面量：secret 非常短且非秘密载体，
    // 计时侧信道无意义——攻击面在 verifyToken 的签名校验，见 authed）
    if (given !== cfg.adminSecret) return jsonError(c, 401, "invalid_secret");
    const exp = Date.now() + cfg.sessionDays * 86_400_000;
    const token = signToken({ sub: "admin", exp }, cfg.adminSecret);
    c.header("set-cookie", cookieHeader(cfg, token, cfg.sessionDays * 86_400));
    return c.json({ ok: true });
  });

  const authed = (c: Context) => {
    const cookie = c.req.header("cookie") ?? "";
    const esc = cfg.cookieName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = cookie.match(new RegExp(`(?:^|;\\s*)${esc}=([^;]+)`));
    if (!m) return null;
    const p = verifyToken(m[1], cfg.adminSecret);
    // verifyToken：HMAC 定时安全比较 + exp 过期校验（承载安全核心，勿简化）
    return p && p.sub === "admin" ? p : null;
  };

  const guard = async (c: Context, next: Next) => {
    if (!authed(c)) return jsonError(c, 401, "unauthorized");
    await next();
  };

  app.post("/api/admin/logout", (c) => {
    // 空 token + Max-Age=0 = 立即清除（cookieHeader 同源 flags，含生产 Secure）
    c.header("set-cookie", cookieHeader(cfg, "", 0));
    return c.json({ ok: true });
  });

  app.get("/api/admin/me", guard, (c) => c.json({ authed: true }));

  app.get("/api/admin/stats", guard, async (c) => {
    try {
      const stats = await repo.messageStats();
      const online = await repo.presenceCount(Date.now() - cfg.presenceTtlMs);
      const hist = await d.maintain(); // 借维护刷新档位（写计数+按需清理）
      return c.json({
        online,
        messages_total: stats.total,
        messages_retained: stats.retained,
        history: {
          mode: hist.mode,
          retention_days: hist.retentionDays,
          estimate_bytes: stats.retained * 400,
        },
      });
    } catch {
      return jsonError(c, 503, "db_unavailable");
    }
  });

  app.get("/api/admin/bans", guard, async (c) => {
    const rawLimit = c.req.query("limit");
    const rawOffset = c.req.query("offset");
    // 与 chat 侧同款整数校验：limit/offset 只收纯数字串（浮点/负数/科学计数拒绝，
    // 避免浮点入 SQL 被方言报错后误映射成 503）——非纯数字 → 400 invalid_cursor
    if (
      (rawLimit !== undefined && !/^\d+$/.test(rawLimit)) ||
      (rawOffset !== undefined && !/^\d+$/.test(rawOffset))
    )
      return jsonError(c, 400, "invalid_cursor", {
        message: "limit/offset 必须是整数",
      });
    const limit = Math.min(Math.max(Number(rawLimit ?? 200), 1), 500);
    const offset = Math.max(Number(rawOffset ?? 0), 0);
    try {
      return c.json({ bans: await repo.banList(limit, offset) });
    } catch {
      return jsonError(c, 503, "db_unavailable");
    }
  });

  app.post("/api/admin/bans", guard, async (c) => {
    const body = await readJson(c);
    if (!body) return jsonError(c, 400, "invalid_body");
    const ip = normalizeIp(body.ip as string);
    const reason =
      typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "";
    if (!ip) return jsonError(c, 400, "invalid_body", { message: "ip 不合法" });
    try {
      // 幂等 upsert：重复封禁覆盖 reason 并返回 created:false（而非 409）
      const created = await repo.banUpsert(
        ip,
        reason || "（未填写原因）",
        "admin",
        Date.now(),
      );
      return c.json({ created, ip });
    } catch {
      return jsonError(c, 503, "db_unavailable");
    }
  });

  app.delete("/api/admin/bans/:ip", guard, async (c) => {
    const ip = normalizeIp(c.req.param("ip"));
    if (!ip) return jsonError(c, 400, "invalid_body", { message: "ip 不合法" });
    try {
      const ok = await repo.banRemove(ip);
      return ok ? c.body(null, 204) : jsonError(c, 404, "not_found");
    } catch {
      return jsonError(c, 503, "db_unavailable");
    }
  });

  app.delete("/api/admin/messages/:id", guard, async (c) => {
    const id = parseIdParam(c.req.param("id"));
    if (!id) return jsonError(c, 400, "invalid_cursor");
    const now = Date.now();
    try {
      const ok = await repo.softDeleteMessage(id, "admin", now);
      if (!ok) return jsonError(c, 404, "not_found");
      // 软删占位广播：delete 事件（payload 只含消息 id，无操作者 IP——隐私约束）
      await repo.insertEvent("delete", JSON.stringify({ id: String(id) }), now);
      return c.body(null, 204);
    } catch {
      return jsonError(c, 503, "db_unavailable");
    }
  });

  // ---------------- 危险操作：清空数据 ----------------
  // 校验链条（任一环不过都触达不到删除）：管理员会话 → 限流（预检与执行共用同一桶）
  // → 档位白名单 → 逐字确认短语 → 二次口令（重输 ADMIN_SECRET）
  // → 一次性令牌（HMAC 签名 + 60s 有效期 + 绑定档位/发起 IP + 单次使用）→ 事务内清空
  const purgeRateGate = async (c: Context, ip: string) => {
    try {
      const rl = await rateCheck(repo, "purge", ip, cfg.rate.purgePerMin);
      if (rl.allowed) return null;
      return jsonError(c, 429, "rate_limited", {
        retry_after_ms: rl.retryAfterMs,
      });
    } catch {
      return jsonError(c, 503, "db_unavailable");
    }
  };

  // 阶段一：预检。只读，返回影响面与确认短语，并下发一次性令牌（本身不删任何数据）。
  app.post("/api/admin/purge/preview", guard, async (c) => {
    const ip = ipOf(c);
    const gate = await purgeRateGate(c, ip);
    if (gate) return gate;
    const body = await readJson(c);
    const scope = (body as { scope?: unknown } | null)?.scope;
    if (!isPurgeScope(scope))
      return jsonError(c, 400, "invalid_body", {
        message: "scope 必须是 chat 或 full",
      });
    try {
      const counts = await repo.purgeCounts();
      const { token, expiresAt } = mintPurgeToken({ scope, ip }, cfg.adminSecret);
      const willDelete = PURGE_TABLES[scope];
      return c.json({
        scope,
        scope_desc: PURGE_SCOPE_DESC[scope],
        will_delete: willDelete,
        keep: PURGE_ALL_TABLES.filter((t) => !willDelete.includes(t)),
        counts,
        // 短语由服务端下发，避免 UI 与校验逻辑措辞漂移
        confirm_phrase: PURGE_PHRASES[scope],
        token,
        expires_at: expiresAt,
      });
    } catch {
      return jsonError(c, 503, "db_unavailable");
    }
  });

  // 阶段二：执行。必须携带预检下发的令牌 + 逐字短语 + 重输的口令。
  app.post("/api/admin/purge", guard, async (c) => {
    const ip = ipOf(c);
    const gate = await purgeRateGate(c, ip);
    if (gate) return gate;
    const body = await readJson(c);
    if (!body) return jsonError(c, 400, "invalid_body");
    const scope = body.scope;
    if (!isPurgeScope(scope))
      return jsonError(c, 400, "invalid_body", {
        message: "scope 必须是 chat 或 full",
      });
    // 逐字确认短语（服务端再校一次，不信任前端校验）
    if (!purgePhraseMatches(scope, body.confirm))
      return jsonError(c, 400, "invalid_confirm", {
        message: `确认短语需逐字输入「${PURGE_PHRASES[scope]}」`,
      });
    // 二次口令：会话 cookie 之外再证明一次持有 ADMIN_SECRET（cookie 被盗不足以清库）
    if (typeof body.secret !== "string" || body.secret !== cfg.adminSecret)
      return jsonError(c, 401, "invalid_secret");
    const verdict = verifyPurgeToken(
      typeof body.token === "string" ? body.token : undefined,
      { scope, ip },
      cfg.adminSecret,
    );
    if (!verdict.ok)
      return jsonError(c, 400, "invalid_token", {
        message: PURGE_TOKEN_MSG[verdict.reason],
      });
    try {
      // 单次使用记账：nonce 落在**当前** 60s 窗口，第二次调用即 >1。
      // （令牌本身 60s 过期，窗口一过该记账行会被常规清理回收；
      //   full 档会连 rate_limits 一起清空 → 已清空的库上重放无额外危害）
      const used = await repo.rateHit("purge_used", verdict.nonce, windowStartFor());
      if (used > 1)
        return jsonError(c, 400, "invalid_token", {
          message: "该预检令牌已被使用，请重新预检",
        });
      const deleted = await repo.clearData(scope);
      // 审计留痕：数据已销毁，只能靠平台日志追溯（不含消息内容/口令等敏感值）
      console.error(
        `[audit] purge scope=${scope} ip=${ip} deleted=${JSON.stringify(deleted)}`,
      );
      return c.json({ scope, deleted });
    } catch {
      return jsonError(c, 503, "db_unavailable");
    }
  });
}
