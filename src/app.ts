import { Hono } from "hono";
import type { AppConfig } from "./lib/config";
import type { Repo } from "./lib/repo";
import { classifyOrigin, normalizeOrigin } from "./lib/security";
import { jsonError, getRequestId, type AppEnv } from "./lib/http";
import { logError, newRequestId } from "./lib/log";
import { registerChat } from "./routes/chat";
import { registerHealth } from "./routes/health";
import { registerAdmin } from "./routes/admin";
import { registerPages } from "./routes/pages";
import { newHistoryState, performMaintenance } from "./lib/history";
import { createMaintenance, type Maintenance } from "./lib/maintenance";
import {
  buildWordFilter,
  loadWordFilter,
  type WordFilter,
} from "./lib/wordfilter";

export interface AppDeps {
  cfg: AppConfig;
  repo: Repo;
  /** 测试可注入自己的调度器（用 flush() 等确定性的时机）。 */
  maintenance?: Maintenance;
}

export interface AppHandle {
  app: Hono<AppEnv>;
  maintenance: Maintenance;
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  return createAppWithHandle(deps).app;
}

export function createAppWithHandle(deps: AppDeps): AppHandle {
  const { cfg, repo } = deps;
  const history = newHistoryState();
  // Seed before the first maintenance so /api/meta reports the configured retention.
  history.retentionDays = cfg.retentionDays;
  let booted: Promise<void> | null = null;
  const boot = async (): Promise<void> => {
    if (!booted)
      booted = (async () => {
        try {
          await repo.bootstrap();
        } catch (err) {
          // Don't cache a rejected bootstrap; the next request retries (DDL is idempotent).
          booted = null;
          throw err;
        }
      })();
    return booted;
  };
  const app = new Hono<AppEnv>();

  // 全站安全头：注册在最前面，任何响应（含 4xx/5xx）都带上。
  app.use("*", async (c, next) => {
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    c.header("x-frame-options", "DENY");
    c.header("permissions-policy", "geolocation=(), camera=(), microphone=()");
    // HSTS 只在生产发：本地 http 开发环境带上它会把浏览器锁死。
    if (cfg.env === "production")
      c.header(
        "strict-transport-security",
        "max-age=31536000; includeSubDomains",
      );
    await next();
  });

  // Lazy wordlist load; on failure degrade to explicit words instead of failing the request.
  let filterPromise: Promise<WordFilter> | null = null;
  const getFilter = (): Promise<WordFilter> => {
    if (!filterPromise) {
      filterPromise = loadWordFilter({
        mode: cfg.bannedWordsMode,
        dir: cfg.bannedWordsDir,
        extra: cfg.bannedWords,
        allow: cfg.bannedWordsAllow,
      }).catch((err) => {
        console.error(
          "[wordfilter] wordlist load failed, using explicit words only:",
          err,
        );
        return buildWordFilter(cfg.bannedWords, cfg.bannedWordsAllow);
      });
    }
    return filterPromise;
  };

  // request id 覆盖所有路径（含静态页的 404）：故障排查时任何响应都能对上日志。
  app.use("*", async (c, next) => {
    const rid = newRequestId();
    c.set("requestId", rid);
    c.header("x-request-id", rid);
    await next();
  });

  // Bootstrap 失败只影响 API；静态页不碰存储，DB 抖动时仍要能打开。
  app.use("/api/*", async (c, next) => {
    try {
      await boot();
    } catch (err) {
      logError("boot", err, { request_id: getRequestId(c) });
      return jsonError(c, 503, "db_unavailable");
    }
    await next();
  });

  app.use("/api/*", async (c, next) => {
    // Never cache API responses: /api/meta carries the caller's IP and /api/stream is unbounded.
    c.header("cache-control", "no-store");
    const origin = c.req.header("origin");
    const cls = classifyOrigin(origin, cfg.allowedOrigins, cfg.requireOrigin);
    if (cls.mode === "open") {
      c.header("access-control-allow-origin", "*");
    } else if (cls.mode === "allowed") {
      c.header("access-control-allow-origin", cls.origin);
      c.header("vary", "Origin");
    } else if (cls.mode === "denied") {
      // Echo the received origin and allowlist size so a stale allowlist is diagnosable.
      return jsonError(c, 403, cls.code, {
        ...(origin ? { origin: normalizeOrigin(origin).slice(0, 256) } : {}),
        allowed_origins_count: cfg.allowedOrigins.length,
      });
    }
    if (c.req.method === "OPTIONS") {
      c.header("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
      c.header("access-control-allow-headers", "content-type");
      c.header("access-control-max-age", "86400");
      return c.body(null, 204);
    }
    await next();
  });

  // 维护在后台跑：写请求只记账，不再替清理付尾延迟。
  const maint =
    deps.maintenance ??
    createMaintenance({
      every: cfg.maintenanceEvery,
      run: async (now) => {
        const res = await performMaintenance(
          { repo, cfg, state: history },
          now,
        );
        if (
          res.mode !== history.mode ||
          res.retentionDays !== history.retentionDays
        ) {
          const prev = history.mode;
          history.mode = res.mode;
          history.retentionDays = res.retentionDays;
          // 只在档位本身变化时广播：天数微调不值得打扰所有客户端。
          if (prev !== res.mode) {
            await repo
              .insertEvent(
                "notice",
                JSON.stringify({
                  kind: "history_mode",
                  mode: res.mode,
                  retention_days: res.retentionDays,
                }),
                now,
              )
              .catch(() => {});
          }
        }
      },
      onError: (err) => logError("maintenance", err),
    });

  // Sync by design: the caller must never wait on cleanup.
  const maintain = (now = Date.now()) => {
    maint.hit(now);
    return { mode: history.mode, retentionDays: history.retentionDays };
  };

  registerHealth(app, { cfg, repo, history });
  registerChat(app, { cfg, repo, history, maintain, getFilter });
  // 管理写操作的同源校验：必须在 registerAdmin 之前注册，否则跑在路由之后等于没拦。
  // 故意不看 ALLOWED_ORIGINS：公开 API 的跨站 allowlist 不该顺带授权删库/封禁。
  app.use("/api/admin/*", async (c, next) => {
    if (!cfg.adminRequireOrigin) return next();
    const m = c.req.method;
    if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
    const origin = c.req.header("origin");
    if (!origin) return jsonError(c, 403, "missing_origin");
    const host =
      c.req.header("x-forwarded-host") ??
      c.req.header("host") ??
      // 某些运行时（含测试里的 Request）不带 host 头，只能从 URL 取。
      new URL(c.req.url).host;
    const proto = (
      c.req.header("x-forwarded-proto") ??
      new URL(c.req.url).protocol.replace(":", "")
    ).toLowerCase();
    const expected = normalizeOrigin(`${proto}://${host}`);
    if (normalizeOrigin(origin) !== expected)
      return jsonError(c, 403, "origin_not_allowed", {
        origin: normalizeOrigin(origin).slice(0, 256),
      });
    await next();
  });
  // Admin routes rely on the /api/* middleware for the origin gate and CORS headers.
  registerAdmin(app, { cfg, repo, history, maintain });
  registerPages(app);
  return { app, maintenance: maint };
}

/** Production wiring; `env` must be passed explicitly or every env var is ignored. */
export async function buildApp(
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
) {
  const { loadConfig } = await import("./lib/config");
  const { createRepo } = await import("./lib/repo");
  const cfg = loadConfig(env);
  const repo = await createRepo(
    cfg.dbProvider,
    cfg.databaseUrl,
    cfg.tursoAuthToken,
  );
  return { cfg, repo, app: createApp({ cfg, repo }) };
}
