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
  noticesSent: { [k in HistoryMode]?: number };
}

export function newHistoryState(): HistoryState {
  return { writeCount: 0, mode: "full", retentionDays: 90, noticesSent: {} };
}

export interface HistoryDeps {
  repo: {
    messageStats(): Promise<{ total: number; retained: number }>;
    cleanupEvents(before: number): Promise<number>;
    cleanupPresence(before: number): Promise<number>;
    cleanupRateLimits(before: number): Promise<number>;
    trimMessagesBelow(idFloor: number): Promise<number>;
    deleteMessagesOlderThan(cutoff: number): Promise<number>;
    /** Must order id-DESC: performMaintenance uses the last row's id as the trim floor. */
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

/** PG messages/events.id is serial/int4: larger values overflow the `id < ?` cast at run time. */
export const MAX_ID_BOUND = 2_147_483_647;

/** Runs every maintenanceEvery writes: expire, trim by days, trim oldest, re-decide mode. */
export async function performMaintenance(
  deps: HistoryDeps,
  now = Date.now(),
): Promise<{ mode: HistoryMode; retentionDays: number; deleted: number }> {
  const { repo, cfg } = deps;
  await repo.cleanupEvents(now - cfg.eventsTtlMs);
  await repo.cleanupPresence(now - cfg.presenceTtlMs * 3);
  await repo.cleanupRateLimits(now - 2 * 3_600_000);
  let { retained } = await repo.messageStats();
  let days = cfg.retentionDays;
  let deleted = 0;
  const dec = decideHistory({ retained }, cfg);
  days = Math.min(days, dec.retentionDays);
  deleted += await repo.deleteMessagesOlderThan(now - days * DAY_MS);
  ({ retained } = await repo.messageStats());
  if (retained >= cfg.maxRows && cfg.maxRows > 0) {
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
