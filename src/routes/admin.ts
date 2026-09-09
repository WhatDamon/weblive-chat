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
import { rateCheck } from "../lib/limits";
import { jsonError, readJson, parseIdParam } from "../lib/http";

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
export function cookieHeader(
  cfg: AppConfig,
  token: string,
  maxAgeSec: number,
): string {
  // Cookie 安全（规格 §5）：Secure 仅生产（测试/本地 http 不设，避免被忽略）；
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
      // 幂等 upsert（Ruling B）：重复封禁 → 覆盖 reason 并回报 created:false（非 409）
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
}
