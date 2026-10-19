/**
 * 进程内计数：Serverless 每实例独立，只用于排障与容量观察，不作业务真相。
 */
const counters = {
  activeStreams: 0,
  dbErrors: 0,
  maintenanceRuns: 0,
  streamsOpened: 0,
};

export type MetricName = keyof typeof counters;

export interface MetricsSnapshot {
  active_streams: number;
  streams_opened: number;
  db_errors: number;
  maintenance_runs: number;
}

export function incMetric(name: MetricName): void {
  counters[name] += 1;
}

export function decMetric(name: MetricName): void {
  counters[name] = Math.max(0, counters[name] - 1);
}

export function resetMetrics(): void {
  for (const k of Object.keys(counters) as MetricName[]) counters[k] = 0;
}

/** 返回拷贝：调用方改快照不得影响计数器。 */
export function metricsSnapshot(): MetricsSnapshot {
  return {
    active_streams: counters.activeStreams,
    streams_opened: counters.streamsOpened,
    db_errors: counters.dbErrors,
    maintenance_runs: counters.maintenanceRuns,
  };
}
