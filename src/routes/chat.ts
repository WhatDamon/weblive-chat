import type { Context, Hono } from "hono";
import type { AppConfig } from "../lib/config";
import type { Repo } from "../lib/repo";
import { MAX_ID_BOUND, type HistoryMode } from "../lib/history";
import { clientIpFromHeaders } from "../lib/security";
import { validateMessageBody, validUuid } from "../lib/validate";
import { rateCheck } from "../lib/limits";
import { runStream } from "../lib/stream";
import { parseIdParam, jsonError, readJson } from "../lib/http";
import { COPY } from "../lib/copy";
import type { WordFilter } from "../lib/wordfilter";

export interface ChatDeps {
  cfg: AppConfig;
  repo: Repo;
  history: { mode: HistoryMode; retentionDays: number };
  maintain?: (
    now?: number,
  ) => Promise<{ mode: HistoryMode; retentionDays: number }>;
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

export function registerChat(app: Hono, d: ChatDeps) {
  const { cfg, repo } = d;

  /** Trust boundary: X-Forwarded-For is trusted only behind the platform proxy. */
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
      // Exposed so operators can curl /api/meta to see if the allowlist locks them out.
      origin_mode: cfg.allowedOrigins.length ? "locked" : "open",
    });
  });

  app.get("/api/messages", async (c) => {
    try {
      const before = parseIdParam(c.req.query("before"));
      const since = parseIdParam(c.req.query("since"));
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
      if (d.history.mode === "ephemeral")
        return c.json({ messages: [], mode: "ephemeral" });
      let rows: any[];
      if (before !== null) rows = await repo.historyBefore(before, limit);
      else if (since !== null) rows = await repo.historySince(since, limit);
      // MAX_ID_BOUND is the PG int4 cursor ceiling; do not use MAX_SAFE_INTEGER here.
      else rows = await repo.historyBefore(MAX_ID_BOUND, limit);
      let cutoff: number | null = null;
      if (cfg.backfillMax > 0) {
        const keep = await repo.historyBefore(MAX_ID_BOUND, cfg.backfillMax);
        cutoff = keep.length >= cfg.backfillMax ? keep[keep.length - 1].id : 0;
      }
      const filtered =
        cutoff === null ? rows : rows.filter((m) => m.id >= cutoff);
      return c.json({
        messages: filtered.map(fmtMessage),
        mode: d.history.mode,
      });
    } catch {
      // Storage failures become 503: this read is polled and must not surface as a 500.
      return jsonError(c, 503, "db_unavailable");
    }
  });

  app.post("/api/messages", async (c) => {
    const ip = ipOf(c);
    const body = await readJson(c);
    if (!body) return jsonError(c, 400, "invalid_body");
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
        const { eventId } = await repo.publishEphemeralMessage(msg);
        await d.maintain?.();
        return c.json(
          { id: `e${eventId}`, created_at: iso(msg.created_at) },
          201,
        );
      }
      const { messageId } = await repo.sendMessageAndEvent(msg);
      await d.maintain?.();
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
    // No ban check here: mute-only, so runStream sends the ban frame and keeps the stream open.
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
    // Dynamic import keeps hono/streaming out of every non-stream request path.
    const { streamSSE } = await import("hono/streaming");
    return streamSSE(c, async (stream) => {
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
          resolve();
        });
      });
    });
  });
}
