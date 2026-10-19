import type { Hono } from "hono";
import type { AppEnv } from "../lib/http";
import type { AppConfig } from "../lib/config";
import type { HistoryMode } from "../lib/history";
import { logError } from "../lib/log";
import { metricsSnapshot } from "../lib/metrics";

/**
 * 健康检查：一次最便宜的探活查询 + 实例内诊断计数。
 * 故意不走 jsonError 信封（机器可读优先），所以不需要新增 ErrCode。
 */
export function registerHealth(
  app: Hono<AppEnv>,
  d: {
    cfg: AppConfig;
    repo: { provider: string; ping(): Promise<void> };
    history: { mode: HistoryMode };
  },
) {
  app.get("/api/health", async (c) => {
    const base = {
      // 报实际 adapter 而不是配置值：两者不一致时宁可让探活把它暴露出来。
      provider: d.repo.provider,
      mode: d.history.mode,
      runtime: metricsSnapshot(),
    };
    try {
      await d.repo.ping();
      return c.json({ ok: true, ...base });
    } catch (err) {
      logError("health", err, { request_id: c.get("requestId") ?? "unknown" });
      return c.json({ ok: false, ...base }, 503);
    }
  });
}
