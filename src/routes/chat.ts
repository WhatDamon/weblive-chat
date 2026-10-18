import type { Context, Hono } from "hono";
import type { AppConfig } from "../lib/config";
import type { ChatRepo } from "../lib/ports";
import { MAX_ID_BOUND, type HistoryMode } from "../lib/history";
import { clientIpFromHeaders } from "../lib/security";
import { validateMessageBody, validUuid } from "../lib/validate";
import { rateCheck } from "../lib/limits";
import { runStream } from "../lib/stream";
import {
  parseIdParam,
  parseSinceParam,
  jsonError,
  readJsonBody,
  failDb,
  type AppEnv,
} from "../lib/http";
import { decMetric, incMetric } from "../lib/metrics";
import { COPY } from "../lib/copy";
import type { WordFilter } from "../lib/wordfilter";

export interface ChatDeps {
  cfg: AppConfig;
  repo: ChatRepo;
  history: { mode: HistoryMode; retentionDays: number };
  maintain?: (now?: number) => { mode: HistoryMode; retentionDays: number };
  getFilter?: () => Promise<WordFilter>;
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

export function registerChat(app: Hono<AppEnv>, d: ChatDeps) {
  const { cfg, repo } = d;

  /** Trust boundary: X-Forwarded-For is trusted only behind the platform proxy. */
  const ipOf = (c: Context<AppEnv>) =>
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
      // Exposed so operators can curl /api/meta to see if the allowlist locks them out.
      origin_mode: cfg.allowedOrigins.length ? "locked" : "open",
    });
  });

  app.get("/api/messages", async (c) => {
    try {
      const before = parseIdParam(c.req.query("before"));
      const since = parseSinceParam(c.req.query("since"));
      if (before !== null && since !== null)
        return jsonError(c, 400, "invalid_body", {
          message: COPY.route.beforeSinceConflict,
        });
      const rawLimit = c.req.query("limit");
      // Digits only: a float would reach SQL; clamp to >=1 instead of silently using 50.
      if (rawLimit !== undefined && !/^\d+$/.test(rawLimit))
        return jsonError(c, 400, "invalid_cursor", {
          message: COPY.route.limitPositiveInt,
        });
      const limit = Math.min(Math.max(Number(rawLimit ?? 50), 1), 200);
      // 独立桶：历史与发消息、开流的预算互不挤占。
      const rl = await rateCheck(
        repo,
        "history",
        ipOf(c),
        cfg.rate.historyPerMin,
      );
      if (!rl.allowed)
        return jsonError(c, 429, "rate_limited", {
          retry_after_ms: rl.retryAfterMs,
        });
      if (d.history.mode === "ephemeral")
        return c.json({ messages: [], mode: "ephemeral" });
      let rows: any[];
      if (before !== null) rows = await repo.historyBefore(before, limit);
      else if (since !== null) rows = await repo.historySince(since, limit);
      // MAX_ID_BOUND is the PG int4 cursor ceiling; do not use MAX_SAFE_INTEGER here.
      else rows = await repo.historyBefore(MAX_ID_BOUND, limit);
      let cutoff: number | null = null;
      if (cfg.backfillMax > 0) {
        // 第 backfillMax 新的 id 就是回溯下界；null 说明行数不足，不设限。
        // 以前这里读回 backfillMax 行再取末行 id，等于为了一个数字搬 N 行。
        cutoff = (await repo.idAtOffset(cfg.backfillMax - 1)) ?? 0;
      }
      const filtered =
        cutoff === null ? rows : rows.filter((m) => m.id >= cutoff);
      return c.json({
        messages: filtered.map(fmtMessage),
        mode: d.history.mode,
      });
    } catch (err) {
      // Storage failures become 503: this read is polled and must not surface as a 500.
      return failDb(c, "chat.messages.get", err);
    }
  });

  app.post("/api/messages", async (c) => {
    const ip = ipOf(c);
    const r = await readJsonBody(c);
    if (!r.ok)
      return r.tooLarge
        ? jsonError(c, 413, "payload_too_large")
        : jsonError(c, 400, "invalid_body");
    const body = r.body;
    // Validate first: bad input must not consume rate budget or touch the DB.
    const filter = d.getFilter ? await d.getFilter() : undefined;
    const v = validateMessageBody(filter ? { ...cfg, filter } : cfg, body);
    if (!v.ok) return jsonError(c, 400, v.code);
    try {
      const ban = await repo.banGet(ip);
      if (ban) return jsonError(c, 403, "banned", { reason: ban.reason }); // mute only
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
        // Ephemeral mode writes only events; the "e" prefix avoids the messages.id space.
        const { messageId } = await repo.publishEphemeralMessage(msg);
        d.maintain?.();
        return c.json({ id: messageId, created_at: iso(msg.created_at) }, 201);
      }
      const { messageId } = await repo.sendMessageAndEvent(msg);
      d.maintain?.();
      return c.json(
        { id: String(messageId), created_at: iso(msg.created_at) },
        201,
      );
    } catch (err) {
      return failDb(c, "chat.messages.post", err);
    }
  });

  app.get("/api/stream", async (c) => {
    const ip = ipOf(c);
    // No ban check here: mute-only, so runStream sends the ban frame and keeps the stream open.
    try {
      const rl = await rateCheck(repo, "stream", ip, cfg.rate.streamPerMin);
      if (!rl.allowed)
        return jsonError(c, 429, "rate_limited", {
          retry_after_ms: rl.retryAfterMs,
        });
    } catch (err) {
      return failDb(c, "chat.stream.rate", err);
    }
    const sinceParam = c.req.query("since");
    const since =
      sinceParam && /^\d+$/.test(sinceParam) ? Number(sinceParam) : 0;
    const clientParam = c.req.query("client_id");
    const clientId =
      clientParam && validUuid(clientParam)
        ? clientParam
        : `anon-${crypto.randomUUID()}`;
    // Dynamic import keeps hono/streaming out of every non-stream request path.
    const { streamSSE } = await import("hono/streaming");
    return streamSSE(c, async (stream) => {
      // SSE 标准字段，给浏览器 EventSource 一个初始重连间隔；
      // 用 stream.write 而不是 writeSSE({retry})，后者在部分 hono 版本会当成 data 帧。
      stream.write("retry: 3000\n\n");
      let counted = true;
      incMetric("activeStreams");
      incMetric("streamsOpened");
      const ctrl = runStream({
        repo,
        cfg: {
          pollMs: cfg.pollMs,
          idlePollMs: cfg.idlePollMs,
          idleAfterMs: cfg.idleAfterMs,
          eventProbeMs: cfg.eventProbeMs,
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
        // A comment line, not a data frame: JSON.parse readers would break on data here.
        emitComment: () => {
          stream.write(": ping\n\n");
        },
      });
      // hono's stream.aborted is a boolean, not a promise: awaiting it would close the stream
      // immediately, so keep this handler pending until the peer disconnects.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          ctrl.stop();
          // onAbort 可能因客户端半开连接被重复回调：只减一次。
          if (counted) {
            counted = false;
            decMetric("activeStreams");
          }
          resolve();
        });
      });
    });
  });
}
