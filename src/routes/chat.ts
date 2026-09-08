import type { Context, Hono } from "hono";
import type { AppConfig } from "../lib/config";
import type { Repo } from "../lib/repo";
import type { HistoryMode } from "../lib/history";
import { clientIpFromHeaders } from "../lib/security";
import { validateMessageBody } from "../lib/validate";
import { rateCheck } from "../lib/limits";
import { parseIdParam, jsonError, readJson } from "../lib/http";

export interface ChatDeps {
  cfg: AppConfig;
  repo: Repo;
  history: { mode: HistoryMode; retentionDays: number };
  /** 每次写后由调用方调用的维护触发；返回最新档位 */
  maintain?: (now?: number) => Promise<{ mode: HistoryMode; retentionDays: number }>;
}

const iso = (ms: number) => new Date(ms).toISOString();
const fmtMessage = (m: any) => ({
  id: String(m.id), client_id: m.client_id, nick: m.nick,
  text: m.text, deleted: m.deleted, created_at: iso(m.created_at),
});

export function registerChat(app: Hono, d: ChatDeps) {
  const { cfg, repo } = d;

  /**
   * 信任边界（T3/C2）：X-Forwarded-For 仅可信代理直连（Vercel 注入）时方可采信；
   * devIp 只在无代理的本地开发回退，生产按 XFF 首跳规范化。前端不可直改本字段内容以外任何链。
   */
  const ipOf = (c: Context) => clientIpFromHeaders({ "x-forwarded-for": c.req.header("x-forwarded-for") }, cfg.devIp);

  app.get("/api/meta", c => {
    const ip = ipOf(c);
    return c.json({
      limits: { nick_max: cfg.nickMax, text_max: cfg.textMax, retention_days: d.history.retentionDays },
      presence: { ttl_s: Math.floor(cfg.presenceTtlMs / 1000) },
      client_ip: ip,
    });
  });

  app.get("/api/messages", async c => {
    const before = parseIdParam(c.req.query("before"));
    const since = parseIdParam(c.req.query("since"));
    if (before !== null && since !== null) return jsonError(c, 400, "invalid_body", { message: "before 与 since 不可同时使用" });
    const rawLimit = c.req.query("limit");
    const limit = Math.min(Math.max(Number(rawLimit ?? 50) || 50, 1), 200);
    if (d.history.mode === "ephemeral") return c.json({ messages: [], mode: "ephemeral" });
    let rows: any[];
    if (before !== null) rows = await repo.historyBefore(before, limit);
    else if (since !== null) rows = await repo.historySince(since, limit);
    else rows = await repo.historyBefore(Number.MAX_SAFE_INTEGER, limit);
    let cutoff: number | null = null;
    if (cfg.backfillMax > 0) {
      const keep = await repo.historyBefore(Number.MAX_SAFE_INTEGER, cfg.backfillMax);
      cutoff = keep.length >= cfg.backfillMax ? keep[keep.length - 1].id : 0;
    }
    const filtered = cutoff === null ? rows : rows.filter(m => m.id >= cutoff);
    return c.json({ messages: filtered.map(fmtMessage), mode: d.history.mode });
  });

  app.post("/api/messages", async c => {
    const ip = ipOf(c);
    const body = await readJson(c);
    if (!body) return jsonError(c, 400, "invalid_body");
    // 纯校验先行：禁词/格式错误不消耗限流预算（与 app.chat 限流用例的语义一致），也不触发 DB 读
    const v = validateMessageBody(cfg, body);
    if (!v.ok) return jsonError(c, 400, v.code);
    try {
      const ban = await repo.banGet(ip);
      if (ban) return jsonError(c, 403, "banned", { reason: ban.reason }); // D5 禁言：禁发不禁看
      const rl = await rateCheck(repo, "msg", ip, cfg.rate.msgPerMin);
      if (!rl.allowed) return jsonError(c, 429, "rate_limited", { retry_after_ms: rl.retryAfterMs });
      const msg = { client_id: body.client_id as string, nick: v.nick, text: v.text, created_at: Date.now() };
      if (d.history.mode === "ephemeral") {
        // §7.2 仅实时：只写 events 广播（payload id 前缀 e 避开 messages.id）
        const { eventId } = await repo.publishEphemeralMessage(msg);
        await d.maintain?.();
        return c.json({ id: `e${eventId}`, created_at: iso(msg.created_at) }, 201);
      }
      const { messageId } = await repo.sendMessageAndEvent(msg);
      await d.maintain?.(); // 每 maintenanceEvery 次写触发清理/档位评估（内部计数判断）
      return c.json({ id: String(messageId), created_at: iso(msg.created_at) }, 201);
    } catch {
      return jsonError(c, 503, "db_unavailable");
    }
  });
}
