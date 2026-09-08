import type { Context, Hono } from "hono";
import type { AppConfig } from "../lib/config";
import type { Repo } from "../lib/repo";
import { MAX_ID_BOUND, type HistoryMode } from "../lib/history";
import { clientIpFromHeaders } from "../lib/security";
import { validateMessageBody, validUuid } from "../lib/validate";
import { rateCheck } from "../lib/limits";
import { runStream } from "../lib/stream";
import { parseIdParam, jsonError, readJson } from "../lib/http";

export interface ChatDeps {
  cfg: AppConfig;
  repo: Repo;
  history: { mode: HistoryMode; retentionDays: number };
  /** 每次写后由调用方调用的维护触发；返回最新档位 */
  maintain?: (
    now?: number,
  ) => Promise<{ mode: HistoryMode; retentionDays: number }>;
}

const iso = (ms: number) => new Date(ms).toISOString();
const fmtMessage = (m: any) => ({
  id: String(m.id),
  client_id: m.client_id,
  nick: m.nick,
  text: m.text,
  deleted: m.deleted,
  created_at: iso(m.created_at),
});

export function registerChat(app: Hono, d: ChatDeps) {
  const { cfg, repo } = d;

  /**
   * 信任边界（T3/C2）：X-Forwarded-For 仅可信代理直连（Vercel 注入）时方可采信；
   * devIp 只在无代理的本地开发回退，生产按 XFF 首跳规范化。前端不可直改本字段内容以外任何链。
   */
  const ipOf = (c: Context) =>
    clientIpFromHeaders(
      { "x-forwarded-for": c.req.header("x-forwarded-for") },
      cfg.devIp,
    );

  app.get("/api/meta", (c) => {
    const ip = ipOf(c);
    return c.json({
      limits: {
        nick_max: cfg.nickMax,
        text_max: cfg.textMax,
        retention_days: d.history.retentionDays,
      },
      presence: { ttl_s: Math.floor(cfg.presenceTtlMs / 1000) },
      client_ip: ip,
    });
  });

  app.get("/api/messages", async (c) => {
    const before = parseIdParam(c.req.query("before"));
    const since = parseIdParam(c.req.query("since"));
    if (before !== null && since !== null)
      return jsonError(c, 400, "invalid_body", {
        message: "before 与 since 不可同时使用",
      });
    const rawLimit = c.req.query("limit");
    // limit 只收纯数字串：浮点/非数字拒绝（避免浮点串入 SQL），0/空按下限 1 夹取，不再静默回落 50
    if (rawLimit !== undefined && !/^\d+$/.test(rawLimit))
      return jsonError(c, 400, "invalid_cursor", {
        message: "limit 必须是正整数",
      });
    const limit = Math.min(Math.max(Number(rawLimit ?? 50), 1), 200);
    if (d.history.mode === "ephemeral")
      return c.json({ messages: [], mode: "ephemeral" });
    let rows: any[];
    if (before !== null) rows = await repo.historyBefore(before, limit);
    else if (since !== null) rows = await repo.historySince(since, limit);
    // MAX_ID_BOUND 为 PG serial/int4 安全上界（同 history.ts performMaintenance 口径），勿改回 MAX_SAFE_INTEGER
    else rows = await repo.historyBefore(MAX_ID_BOUND, limit);
    let cutoff: number | null = null;
    if (cfg.backfillMax > 0) {
      const keep = await repo.historyBefore(MAX_ID_BOUND, cfg.backfillMax);
      cutoff = keep.length >= cfg.backfillMax ? keep[keep.length - 1].id : 0;
    }
    const filtered =
      cutoff === null ? rows : rows.filter((m) => m.id >= cutoff);
    return c.json({ messages: filtered.map(fmtMessage), mode: d.history.mode });
  });

  app.post("/api/messages", async (c) => {
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
      if (!rl.allowed)
        return jsonError(c, 429, "rate_limited", {
          retry_after_ms: rl.retryAfterMs,
        });
      const msg = {
        client_id: body.client_id as string,
        nick: v.nick,
        text: v.text,
        created_at: Date.now(),
      };
      if (d.history.mode === "ephemeral") {
        // §7.2 仅实时：只写 events 广播（payload id 前缀 e 避开 messages.id）
        const { eventId } = await repo.publishEphemeralMessage(msg);
        await d.maintain?.();
        return c.json(
          { id: `e${eventId}`, created_at: iso(msg.created_at) },
          201,
        );
      }
      const { messageId } = await repo.sendMessageAndEvent(msg);
      await d.maintain?.(); // 每 maintenanceEvery 次写触发清理/档位评估（内部计数判断）
      return c.json(
        { id: String(messageId), created_at: iso(msg.created_at) },
        201,
      );
    } catch {
      return jsonError(c, 503, "db_unavailable");
    }
  });

  app.get("/api/stream", async (c) => {
    const ip = ipOf(c);
    // 规格 §6 强制：开流 20 次/min（stream 桶按 IP，仿 POST msg 桶模式）——
    // 控制者裁定：stream 桶此前悬空（全仓无调用点），开流前检查、超限 429。
    // 禁言不禁看语义不变：stream 不做 banGet 拦截（禁言提示由 runStream 经 cfg.ip 发 ban 首帧）。
    try {
      const rl = await rateCheck(repo, "stream", ip, cfg.rate.streamPerMin);
      if (!rl.allowed)
        return jsonError(c, 429, "rate_limited", {
          retry_after_ms: rl.retryAfterMs,
        });
    } catch {
      return jsonError(c, 503, "db_unavailable");
    }
    const sinceParam = c.req.query("since");
    const since =
      sinceParam && /^\d+$/.test(sinceParam) ? Number(sinceParam) : 0;
    const clientParam = c.req.query("client_id");
    const clientId =
      clientParam && validUuid(clientParam)
        ? clientParam
        : `anon-${crypto.randomUUID()}`;
    // 动态 import：仅流请求路径加载 hono/streaming（其余请求零开销）
    const { streamSSE } = await import("hono/streaming");
    return streamSSE(c, async (stream) => {
      // ip 在 StreamCfg（账本 seam）：runStream 经 cfg.ip → repo.banGet 做禁言提示
      const ctrl = runStream({
        repo,
        cfg: {
          pollMs: cfg.pollMs,
          presenceUpsertMs: cfg.presenceUpsertMs,
          presenceCountMs: cfg.presenceCountMs,
          heartbeatMs: cfg.heartbeatMs,
          presenceTtlMs: cfg.presenceTtlMs,
          ip,
        },
        clientId,
        since,
        emit: (type, data) => {
          stream.writeSSE({ event: type, data: JSON.stringify(data) });
        },
        // 心跳已由 runStream 按 heartbeatMs 经注释行保活（非 data 帧，客户端忽略）
        emitComment: () => {
          stream.write(": ping\n\n");
        },
      });
      // 简报硬伤 + Ruling：hono 4.13.7 的 SSEStreamingApi.aborted 是布尔不是
      // Promise，直接 await 会秒回并触发 run() finally close 关流；改为挂 onAbort
      // 回调 stop 控制器并 resolve，回调挂起到客户端断开才返回。
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          ctrl.stop();
          resolve();
        });
      });
    });
  });
}
