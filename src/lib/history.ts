export type HistoryMode = "full" | "degraded_retention" | "ephemeral";
export const RETENTION_LADDER_DAYS = [90, 30, 10, 3, 1];
const DAY_MS = 86_400_000;
// 行数占比阈值 → 收缩后保留天数：接近上限时逐级 90→30→10→3→1（`HISTORY_RETENTION_DAYS` 为基线上限）。
// 阈值按占比升序；命中即覆盖为更短档，循环结束后保留的是最高命中阈值对应天数（最严档）。
const STEPS: [number, number][] = [
  [0.5, 30],
  [0.7, 10],
  [0.85, 3],
  [0.95, 1],
];

export function decideHistory(
  stats: { retained: number },
  cfg: { retentionDays: number; maxRows: number },
): { mode: HistoryMode; retentionDays: number } {
  const max = cfg.maxRows;
  if (max <= 0 || stats.retained >= max)
    return { mode: "ephemeral", retentionDays: 1 };
  const ratio = stats.retained / max;
  let days = cfg.retentionDays;
  for (const [threshold, d] of STEPS) {
    // Math.min 保护：阶梯天数永不高于配置基线；cfg.retentionDays < 30 时高负载不得反向升档/静默拉长保留期
    if (ratio >= threshold) days = Math.min(days, d);
  }
  if (days === cfg.retentionDays) return { mode: "full", retentionDays: days };
  return { mode: "degraded_retention", retentionDays: days };
}

export interface HistoryState {
  writeCount: number;
  mode: HistoryMode;
  retentionDays: number;
  noticesSent: { [k in HistoryMode]?: number };
}

export function newHistoryState(): HistoryState {
  return { writeCount: 0, mode: "full", retentionDays: 90, noticesSent: {} };
}

export interface HistoryDeps {
  repo: {
    /** messageStats 口径 = 物理行（含软删占位），容量/降级/estimate_bytes 唯一依据 */
    messageStats(): Promise<{ total: number; retained: number }>;
    cleanupEvents(before: number): Promise<number>;
    cleanupPresence(before: number): Promise<number>;
    cleanupRateLimits(before: number): Promise<number>;
    trimMessagesBelow(idFloor: number): Promise<number>;
    deleteMessagesOlderThan(cutoff: number): Promise<number>;
    /**
     * 排序约定：id 降序（最新在前）——performMaintenance 取 rows[rows.length-1].id
     * 作为第 maxRows 新的 id（裁剪下限），依赖此序，勿改。
     */
    historyBefore(before: number, limit: number): Promise<{ id: number }[]>;
  };
  cfg: {
    maxRows: number;
    retentionDays: number;
    presenceTtlMs: number;
    eventsTtlMs: number;
    maintenanceEvery: number;
  };
}

// PG 的 messages.id 为 serial（int4）：不能把 Number.MAX_SAFE_INTEGER 直接作为 `id < ?` 的实参——
// postgres.js 以文本发送数字、PG 按 int4 列类型解析 → 执行期 out of range。
// sqlite INTEGER 存 2_147_483_647 亦无碍（保留期裁剪封顶 ~maxRows 行，id 现实远低于此）。
export const MAX_ID_BOUND = 2_147_483_647;

/**
 * 维护入口：每 maintenanceEvery 次写调用一次。
 * 顺序：清过期(events/presence/rate_limits) → 按当前档天数删过期消息 → 若仍超行数则裁剪最旧 → 重算档位。
 * 返回新档位与清理量；由调用方决定是否广播 notice（跨实例各自重算、一致收敛）。
 */
export async function performMaintenance(
  deps: HistoryDeps,
  now = Date.now(),
): Promise<{ mode: HistoryMode; retentionDays: number; deleted: number }> {
  const { repo, cfg } = deps;
  await repo.cleanupEvents(now - cfg.eventsTtlMs);
  await repo.cleanupPresence(now - cfg.presenceTtlMs * 3);
  await repo.cleanupRateLimits(now - 2 * 3_600_000);
  // 物理行口径：retained = 物理行（含软删占位），决定档位/裁剪（容量唯一依据）
  let { retained } = await repo.messageStats();
  let days = cfg.retentionDays;
  let deleted = 0;
  // 先按档位天数裁剪（决定档位时用裁剪前的 retained）
  const dec = decideHistory({ retained }, cfg);
  days = Math.min(days, dec.retentionDays);
  deleted += await repo.deleteMessagesOlderThan(now - days * DAY_MS);
  ({ retained } = await repo.messageStats());
  if (retained >= cfg.maxRows && cfg.maxRows > 0) {
    // 保留最新 maxRows 条：取第 maxRows 新的 id 作为裁剪下限
    const rows = await repo.historyBefore(MAX_ID_BOUND, cfg.maxRows);
    if (rows.length >= cfg.maxRows) {
      const floor = rows[rows.length - 1].id;
      deleted += await repo.trimMessagesBelow(floor);
      ({ retained } = await repo.messageStats());
    }
  }
  const final = decideHistory({ retained }, cfg);
  return { mode: final.mode, retentionDays: final.retentionDays, deleted };
}
