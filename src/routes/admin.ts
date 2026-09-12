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
import { COPY, fill } from "../lib/copy";
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
  maintain: (
    now?: number,
  ) => Promise<{ mode: HistoryMode; retentionDays: number }>;
}

const COOKIE_FLAGS = "HttpOnly; SameSite=Lax; Path=/";

/** Operator-facing hints; never include secrets. */
const PURGE_TOKEN_MSG: Record<PurgeTokenReason, string> = {
  invalid_token: COPY.purge.tokenInvalid,
  token_scope: COPY.purge.tokenScope,
  token_ip: COPY.purge.tokenIp,
};
export function cookieHeader(
  cfg: AppConfig,
  token: string,
  maxAgeSec: number,
): string {
  // Secure only in production; over local http a Secure cookie would be dropped.
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
    // Rate limit before comparing the secret so wrong guesses also consume budget.
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
    // Comparing the literal is fine: the timing-sensitive path is verifyToken below.
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
    // verifyToken does constant-time HMAC comparison plus an exp check; do not simplify.
    return p && p.sub === "admin" ? p : null;
  };

  const guard = async (c: Context, next: Next) => {
    if (!authed(c)) return jsonError(c, 401, "unauthorized");
    await next();
  };

  app.post("/api/admin/logout", (c) => {
    c.header("set-cookie", cookieHeader(cfg, "", 0));
    return c.json({ ok: true });
  });

  app.get("/api/admin/me", guard, (c) => c.json({ authed: true }));

  app.get("/api/admin/stats", guard, async (c) => {
    try {
      const stats = await repo.messageStats();
      const online = await repo.presenceCount(Date.now() - cfg.presenceTtlMs);
      const hist = await d.maintain();
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
    // Digits only: a float reaching SQL fails per dialect and would be mis-mapped to 503.
    if (
      (rawLimit !== undefined && !/^\d+$/.test(rawLimit)) ||
      (rawOffset !== undefined && !/^\d+$/.test(rawOffset))
    )
      return jsonError(c, 400, "invalid_cursor", {
        message: COPY.route.limitOffsetInt,
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
    if (!ip)
      return jsonError(c, 400, "invalid_body", {
        message: COPY.route.ipInvalid,
      });
    try {
      // Idempotent: re-banning overwrites the reason and reports created:false (no 409).
      const created = await repo.banUpsert(
        ip,
        reason || COPY.route.banReasonBlank,
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
    if (!ip)
      return jsonError(c, 400, "invalid_body", {
        message: COPY.route.ipInvalid,
      });
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
      // Delete event carries only the message id; never the operator IP.
      await repo.insertEvent("delete", JSON.stringify({ id: String(id) }), now);
      return c.body(null, 204);
    } catch {
      return jsonError(c, 503, "db_unavailable");
    }
  });

  // Verify chain: session -> rate limit (shared bucket) -> scope -> phrase -> secret -> token.
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

  // Phase 1 (read-only): impact preview and a one-time token; deletes nothing.
  app.post("/api/admin/purge/preview", guard, async (c) => {
    const ip = ipOf(c);
    const gate = await purgeRateGate(c, ip);
    if (gate) return gate;
    const body = await readJson(c);
    const scope = (body as { scope?: unknown } | null)?.scope;
    if (!isPurgeScope(scope))
      return jsonError(c, 400, "invalid_body", {
        message: COPY.route.scopeInvalid,
      });
    try {
      const counts = await repo.purgeCounts();
      const { token, expiresAt } = mintPurgeToken(
        { scope, ip },
        cfg.adminSecret,
      );
      const willDelete = PURGE_TABLES[scope];
      return c.json({
        scope,
        scope_desc: PURGE_SCOPE_DESC[scope],
        will_delete: willDelete,
        keep: PURGE_ALL_TABLES.filter((t) => !willDelete.includes(t)),
        counts,
        // Server sends the phrase so the UI cannot drift from the server's expectation.
        confirm_phrase: PURGE_PHRASES[scope],
        token,
        expires_at: expiresAt,
      });
    } catch {
      return jsonError(c, 503, "db_unavailable");
    }
  });

  app.post("/api/admin/purge", guard, async (c) => {
    const ip = ipOf(c);
    const gate = await purgeRateGate(c, ip);
    if (gate) return gate;
    const body = await readJson(c);
    if (!body) return jsonError(c, 400, "invalid_body");
    const scope = body.scope;
    if (!isPurgeScope(scope))
      return jsonError(c, 400, "invalid_body", {
        message: COPY.route.scopeInvalid,
      });
    // Re-check the phrase server-side; client validation is not trusted.
    if (!purgePhraseMatches(scope, body.confirm))
      return jsonError(c, 400, "invalid_confirm", {
        message: fill(COPY.route.confirmPhraseMismatch, {
          phrase: PURGE_PHRASES[scope],
        }),
      });
    // Second proof of ADMIN_SECRET: a stolen session cookie must not wipe the DB.
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
      // Book the nonce in the current window; maintenance would purge a window-0 marker early.
      const used = await repo.rateHit(
        "purge_used",
        verdict.nonce,
        windowStartFor(),
      );
      if (used > 1)
        return jsonError(c, 400, "invalid_token", {
          message: COPY.route.tokenUsed,
        });
      const deleted = await repo.clearData(scope);
      // Audit trail: platform logs are the only record after data is destroyed. No secrets.
      console.error(
        `[audit] purge scope=${scope} ip=${ip} deleted=${JSON.stringify(deleted)}`,
      );
      return c.json({ scope, deleted });
    } catch {
      return jsonError(c, 503, "db_unavailable");
    }
  });
}
