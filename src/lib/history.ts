export type HistoryMode = "full" | "degraded_retention" | "ephemeral";
export const RETENTION_LADDER_DAYS = [90, 30, 10, 3, 1];
const DAY_MS = 86_400_000;
// retained/maxRows thresholds → shorter retention (HISTORY_RETENTION_DAYS caps it).
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
    // Math.min: the ladder must never raise retention above the configured baseline.
    if (ratio >= threshold) days = Math.min(days, d);
  }
  if (days === cfg.retentionDays) return { mode: "full", retentionDays: days };
  return { mode: "degraded_retention", retentionDays: days };
}

export interface HistoryState {
  writeCount: number;
  mode: HistoryMode;
  retentionDays: number;
  /** 最近一次 COUNT 的结果与时间：短时间内重复维护不必再扫表。 */
  stats: { at: number; retained: number } | null;
}

export function newHistoryState(): HistoryState {
  return {
    writeCount: 0,
    mode: "full",
    retentionDays: 90,
    stats: null,
  };
}

export interface HistoryDeps {
  /** 档位 + 统计缓存的跨次状态（app 里与 history 同寿）。 */
  state: HistoryState;
  repo: {
    messageStats(): Promise<{ total: number; retained: number }>;
    cleanupEvents(before: number): Promise<number>;
    cleanupPresence(before: number): Promise<number>;
    cleanupRateLimits(before: number): Promise<number>;
    trimMessagesBelow(idFloor: number): Promise<number>;
    deleteMessagesOlderThan(cutoff: number): Promise<number>;
    /** 第 offset 新的消息 id（0 起），越界返回 null：触顶裁剪的边界查询。 */
    idAtOffset(offset: number): Promise<number | null>;
  };
  cfg: {
    maxRows: number;
    retentionDays: number;
    presenceTtlMs: number;
    eventsTtlMs: number;
    statsTtlMs: number;
    maintenanceEvery: number;
  };
}

/** PG messages/events.id is serial/int4: larger values overflow the `id < ?` cast at run time. */
export const MAX_ID_BOUND = 2_147_483_647;

/** Runs every maintenanceEvery writes: expire, trim by days, trim oldest, re-decide mode. */
export async function performMaintenance(
  deps: HistoryDeps,
  now = Date.now(),
): Promise<{ mode: HistoryMode; retentionDays: number; deleted: number }> {
  const { repo, cfg, state } = deps;
  await repo.cleanupEvents(now - cfg.eventsTtlMs);
  await repo.cleanupPresence(now - cfg.presenceTtlMs * 3);
  await repo.cleanupRateLimits(now - 2 * 3_600_000);
  // COUNT(*) 是这里最贵的查询：缓存期内复用，删除量按差值折算而不是再数一遍。
  let retained: number;
  const cached = state.stats;
  if (cached && now - cached.at < cfg.statsTtlMs) {
    retained = cached.retained;
  } else {
    ({ retained } = await repo.messageStats());
  }
  let deleted = 0;
  const dec = decideHistory({ retained }, cfg);
  const days = Math.min(cfg.retentionDays, dec.retentionDays);
  const deletedDays = await repo.deleteMessagesOlderThan(now - days * DAY_MS);
  deleted += deletedDays;
  retained = Math.max(0, retained - deletedDays);
  if (retained >= cfg.maxRows && cfg.maxRows > 0) {
    const floor = await repo.idAtOffset(cfg.maxRows - 1);
    // floor 是第 maxRows 新的 id：删掉更早的，正好留 maxRows 行；null 表示不足 maxRows。
    if (floor !== null) {
      const trimmed = await repo.trimMessagesBelow(floor);
      deleted += trimmed;
      retained = Math.max(0, retained - trimmed);
    }
  }
  state.stats = { at: now, retained };
  const final = decideHistory({ retained }, cfg);
  return { mode: final.mode, retentionDays: final.retentionDays, deleted };
}
