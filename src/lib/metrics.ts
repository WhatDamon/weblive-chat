/**
 * 进程内诊断计数：每个实例各算各的，只用来回答「这个实例现在健康吗」，
 * 不是业务真相（实例会被平台随时回收/横向扩容）。任务 5 补齐计数点。
 */
export interface MetricsSnapshot {
  active_streams: number;
  streams_opened: number;
  db_errors: number;
  maintenance_runs: number;
}

export function metricsSnapshot(): MetricsSnapshot {
  return {
    active_streams: 0,
    streams_opened: 0,
    db_errors: 0,
    maintenance_runs: 0,
  };
}
