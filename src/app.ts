import { Hono } from "hono";
import type { AppConfig } from "./lib/config";
import type { Repo } from "./lib/repo";
import { classifyOrigin } from "./lib/security";
import { jsonError } from "./lib/http";
import { registerChat } from "./routes/chat";
import { newHistoryState, performMaintenance } from "./lib/history";

export interface AppDeps { cfg: AppConfig; repo: Repo }

export function createApp(deps: AppDeps): Hono {
  const { cfg, repo } = deps;
  const history = newHistoryState();
  let booted: Promise<void> | null = null;
  const boot = () => (booted ??= (async () => { if (cfg.migrateOnBoot) await repo.bootstrap(); })());
  const app = new Hono();

  // 惰性 boot（Vercel 冷启动幂等）+ 每请求快路径
  app.use("*", async (c, next) => { await boot(); await next(); });

  // /api 中间件：Origin 闸口（§6.1）+ CORS 响应头
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    const cls = classifyOrigin(origin, cfg.allowedOrigins, cfg.requireOrigin);
    if (cls.mode === "open") {
      c.header("access-control-allow-origin", "*");
    } else if (cls.mode === "allowed") {
      c.header("access-control-allow-origin", cls.origin);
      c.header("vary", "Origin");
    } else if (cls.mode === "denied") {
      return jsonError(c, 403, cls.code);
    }
    if (c.req.method === "OPTIONS") {
      c.header("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
      c.header("access-control-allow-headers", "content-type");
      c.header("access-control-max-age", "86400");
      return c.body(null, 204);
    }
    await next();
  });

  registerChat(app, {
    cfg, repo, history,
    // §7.2 维护：每 maintenanceEvery 次写触发一次清理与档位评估；档位变化广播 notice
    maintain: async (now = Date.now()) => {
      history.writeCount += 1;
      if (history.writeCount % cfg.maintenanceEvery !== 0) return { mode: history.mode, retentionDays: history.retentionDays };
      const res = await performMaintenance({ repo, cfg }, now);
      if (res.mode !== history.mode || res.retentionDays !== history.retentionDays) {
        const prev = history.mode;
        history.mode = res.mode;
        history.retentionDays = res.retentionDays;
        if (prev !== res.mode) {
          await repo.insertEvent("notice", JSON.stringify({ kind: "history_mode", mode: res.mode, retention_days: res.retentionDays }), now).catch(() => {});
        }
      }
      return { mode: history.mode, retentionDays: history.retentionDays };
    },
  });
  // T7: registerAdmin(app, {cfg, repo}); T8: registerPages(app);
  return app;
}
