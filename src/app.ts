import { Hono } from "hono";
import type { AppConfig } from "./lib/config";
import type { Repo } from "./lib/repo";
import { classifyOrigin, normalizeOrigin } from "./lib/security";
import { jsonError } from "./lib/http";
import { registerChat } from "./routes/chat";
import { registerAdmin } from "./routes/admin";
import { registerPages } from "./routes/pages";
import { newHistoryState, performMaintenance } from "./lib/history";
import {
  buildWordFilter,
  loadWordFilter,
  type WordFilter,
} from "./lib/wordfilter";

export interface AppDeps {
  cfg: AppConfig;
  repo: Repo;
}

export function createApp(deps: AppDeps): Hono {
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
  const app = new Hono();

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

  // Bootstrap failure maps to 503 so a storage outage never surfaces as a bare 500.
  app.use("*", async (c, next) => {
    try {
      await boot();
    } catch {
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

  // Shared by chat and admin so history mode and write counts have one source of truth.
  const maintain = async (now = Date.now()) => {
    history.writeCount += 1;
    if (history.writeCount % cfg.maintenanceEvery !== 0)
      return { mode: history.mode, retentionDays: history.retentionDays };
    const res = await performMaintenance({ repo, cfg }, now);
    if (
      res.mode !== history.mode ||
      res.retentionDays !== history.retentionDays
    ) {
      const prev = history.mode;
      history.mode = res.mode;
      history.retentionDays = res.retentionDays;
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
    return { mode: history.mode, retentionDays: history.retentionDays };
  };

  registerChat(app, { cfg, repo, history, maintain, getFilter });
  // Admin routes rely on the /api/* middleware for the origin gate and CORS headers.
  registerAdmin(app, { cfg, repo, history, maintain });
  registerPages(app);
  return app;
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
