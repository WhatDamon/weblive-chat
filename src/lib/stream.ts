import type { EventRow } from "./repo";

export interface StreamRepo {
  eventsSince(since: number, limit: number): Promise<EventRow[]>;
  eventsMaxId(): Promise<number>;
  presenceUpsert(clientId: string, at: number): Promise<void>;
  presenceCount(cutoff: number): Promise<number>;
  banGet(ip: string): Promise<{ reason: string } | null>;
}

export interface StreamCfg {
  pollMs: number; presenceUpsertMs: number; presenceCountMs: number;
  heartbeatMs: number; presenceTtlMs: number; ip?: string;
}
export interface StreamOpts {
  repo: StreamRepo;
  cfg: StreamCfg;
  clientId: string;
  /** 起始游标：缺省 0（从头开始增量）。 */
  since?: number;
  emit: (type: string, data: unknown) => void;
  /** 心跳注释行写入口：缺省 no-op（测试/无需保活场景可不传）。 */
  emitComment?: (text: string) => void;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** 返回控制柄：start() 进入循环（异步），stop() 请求停止。 */
export function runStream(o: StreamOpts): { stop: () => void } {
  let stopped = false;
  let since = o.since ?? 0;
  let lastOnline: number | null = null;
  let lastSent = Date.now();
  let lastUpsert = 0;
  let lastCount = 0;
  const emitComment = o.emitComment ?? (() => {});

  const tickPoll = async () => {
    let rows = await o.repo.eventsSince(since, 100);
    if (rows.length === 0 && since > 0) {
      // 游标回退（规格 §5「流与游标语义」）：events 已清理 → 重置到当前 max
      const maxId = await o.repo.eventsMaxId();
      if (since > maxId) since = Math.max(maxId, 0);
      rows = await o.repo.eventsSince(since, 100);
    }
    for (const e of rows) {
      since = e.id;
      let data: unknown = {};
      try { data = JSON.parse(e.payload); } catch { data = { raw: e.payload }; }
      o.emit(e.type, data);
    }
    lastSent = Date.now();
  };
  // 时间门控：upsert/COUNT 按各自节拍（cfg.presenceUpsertMs / countMs）执行，轮询 tick 只负责 pollMs
  const tickUpsert = async () => {
    const now = Date.now();
    if (now - lastUpsert < o.cfg.presenceUpsertMs) return;
    lastUpsert = now;
    await o.repo.presenceUpsert(o.clientId, now);
  };
  const tickCount = async () => {
    const now = Date.now();
    if (now - lastCount < o.cfg.presenceCountMs) return;
    lastCount = now;
    const online = await o.repo.presenceCount(now - o.cfg.presenceTtlMs);
    if (online !== lastOnline) { lastOnline = online; o.emit("presence", { online }); }
  };

  (async () => {
    if (o.cfg.ip) {
      const ban = await o.repo.banGet(o.cfg.ip);
      if (ban) o.emit("ban", { reason: ban.reason }); // D5：禁言提示，流保持
    }
    await tickUpsert();
    await tickCount();
    lastUpsert = Date.now(); // 初始心跳记时，避免下一 tick 立即重复
    lastCount = lastUpsert;
    while (!stopped) {
      const cycleStart = Date.now();
      await tickPoll();
      if (stopped) break;
      await tickUpsert();
      if (Date.now() - lastSent >= o.cfg.heartbeatMs) { emitComment("ping"); lastSent = Date.now(); }
      await tickCount();
      const elapsed = Date.now() - cycleStart;
      await sleep(Math.max(o.cfg.pollMs - elapsed, 0)); // 对齐 tick，防 async 堆积
    }
  })().catch(err => {
    o.emit("error", { code: "db_unavailable", message: String(err) });
    stopped = true;
  });

  return { stop: () => { stopped = true; } };
}
