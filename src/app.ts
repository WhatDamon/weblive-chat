import { Hono } from "hono";
import type { AppConfig } from "./lib/config";
import type { Repo } from "./lib/repo";
import { classifyOrigin } from "./lib/security";
import { jsonError } from "./lib/http";
import { registerChat } from "./routes/chat";
import { registerAdmin } from "./routes/admin";
import { registerPages } from "./routes/pages";
import { newHistoryState, performMaintenance } from "./lib/history";

export interface AppDeps {
  cfg: AppConfig;
  repo: Repo;
}

export function createApp(deps: AppDeps): Hono {
  const { cfg, repo } = deps;
  const history = newHistoryState();
  // HISTORY_RETENTION_DAYS 播种：/api/meta 首次维护前即回报正确 retention_days（不干扰 notice 的 mode 判定）
  history.retentionDays = cfg.retentionDays;
  let booted: Promise<void> | null = null;
  const boot = async (): Promise<void> => {
    if (!booted)
      booted = (async () => {
        try {
          if (cfg.migrateOnBoot) await repo.bootstrap();
        } catch (err) {
          // bootstrap 失败不缓存 rejected promise（勿用 ??= 永久记忆失败）：
          // 同实例下 DB 恢复后下一请求自动重试 bootstrap（DDL 幂等，自愈）；
          // 并发双跑无害（CREATE TABLE IF NOT EXISTS），失败统一由中间件映射 503。
          booted = null;
          throw err;
        }
      })();
    return booted;
  };
  const app = new Hono();

  // 惰性 boot（Vercel 冷启动幂等）+ 每请求快路径；bootstrap 异常统一 503 信封
  // （§5.3/§7.2：存储不可用不得泄漏成默认 500）
  app.use("*", async (c, next) => {
    try {
      await boot();
    } catch {
      return jsonError(c, 503, "db_unavailable");
    }
    await next();
  });

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

  // §7.2 维护：每 maintenanceEvery 次写触发一次清理与档位评估；档位变化广播 notice
  // （chat 与 admin 共用同一维护闭包与 history 状态，保持档位/计数单一来源）
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

  registerChat(app, { cfg, repo, history, maintain });
  // T7：管理 JSON API（HMAC Cookie 会话；Origin 闸口已由 /api/* 中间件覆盖）
  registerAdmin(app, { cfg, repo, history, maintain });
  // T8：同源静态页（零构建 admin.html/demo.html 参考客户端，D15）
  registerPages(app);
  return app;
}

/**
 * 生产组装（读真实 env：Bun 自动加载 .env 到 process.env；Vercel 注入 process.env）。
 * index.ts 双入口共用；buildApp() 由 loadConfig 读取 process.env——注意 loadConfig 只读
 * 传入的 env（不隐式读 process.env），此处必须显式传，否则 dev/server 将忽略全部环境变量。
 */
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
