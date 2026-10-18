import type { EventRow } from "./repo";
import { logError } from "./log";

export interface StreamRepo {
  eventsSince(since: number, limit: number): Promise<EventRow[]>;
  eventsMaxId(): Promise<number>;
  presenceUpsert(clientId: string, at: number): Promise<void>;
  presenceCount(cutoff: number): Promise<number>;
  banGet(ip: string): Promise<{ reason: string } | null>;
}

export interface StreamCfg {
  pollMs: number;
  idlePollMs: number;
  idleAfterMs: number;
  eventProbeMs: number;
  presenceUpsertMs: number;
  presenceCountMs: number;
  heartbeatMs: number;
  presenceTtlMs: number;
  ip?: string;
}
export interface StreamOpts {
  repo: StreamRepo;
  cfg: StreamCfg;
  clientId: string;
  since?: number;
  emit: (type: string, data: unknown) => void;
  emitComment?: (text: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 单轮最多取多少条：与 eventsSince 的 LIMIT 约定一致。 */
const POLL_LIMIT = 100;
/** 单 tick 最多排空几轮：上限保证一次突发不会把 tick 拖成无限循环。 */
const MAX_DRAIN_ROUNDS = 5;

export function runStream(o: StreamOpts): { stop: () => void } {
  let stopped = false;
  let since = o.since ?? 0;
  let lastOnline: number | null = null;
  let lastSent = Date.now();
  let lastEventAt = Date.now();
  let lastProbe = 0;
  let lastUpsert = 0;
  let lastCount = 0;
  const emitComment = o.emitComment ?? (() => {});

  const tickPoll = async () => {
    let pushed = 0;
    let probed = false;
    // 一轮只取 100 条，突发时会积压；单 tick 内多排几轮，代价是有上限的额外查询。
    for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
      let rows = await o.repo.eventsSince(since, POLL_LIMIT);
      // Cursor fallback: events behind the cursor were already purged. Probed at most once per
      // eventProbeMs (and once per tick), otherwise an idle stream would double its queries.
      if (
        rows.length === 0 &&
        !probed &&
        since > 0 &&
        Date.now() - lastProbe >= o.cfg.eventProbeMs
      ) {
        probed = true;
        lastProbe = Date.now();
        const maxId = await o.repo.eventsMaxId();
        if (since > maxId) since = Math.max(maxId, 0);
        rows = await o.repo.eventsSince(since, POLL_LIMIT);
      }
      for (const e of rows) {
        since = e.id;
        let data: unknown = {};
        try {
          data = JSON.parse(e.payload);
        } catch {
          data = { raw: e.payload };
        }
        o.emit(e.type, data);
        pushed++;
      }
      // 不足一页说明已经排空，不必再多查一次。
      if (rows.length < POLL_LIMIT) break;
    }
    // lastSent only advances on real writes, so an idle stream still reaches the heartbeat.
    if (pushed > 0) {
      lastSent = Date.now();
      lastEventAt = lastSent;
    }
  };
  // Rate-gate presence writes and counts: at 1s ticks they would blow the DB write budget.
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
    if (online !== lastOnline) {
      lastOnline = online;
      o.emit("presence", { online });
      lastSent = Date.now();
    }
  };

  (async () => {
    if (o.cfg.ip) {
      const ban = await o.repo.banGet(o.cfg.ip);
      if (ban) {
        o.emit("ban", { reason: ban.reason }); // mute-only: keep the stream open
        lastSent = Date.now();
      }
    }
    await tickUpsert();
    await tickCount();
    lastUpsert = Date.now();
    lastCount = lastUpsert;
    while (!stopped) {
      const cycleStart = Date.now();
      await tickPoll();
      if (stopped) break;
      await tickUpsert();
      if (Date.now() - lastSent >= o.cfg.heartbeatMs) {
        emitComment("ping");
        lastSent = Date.now();
      }
      await tickCount();
      const elapsed = Date.now() - cycleStart;
      // Quiet streams back off: fewer wakeups, fewer queries, and no held-open instance does realtime
      // work when nobody is talking. An event resets the cadence to pollMs.
      const quiet = Date.now() - lastEventAt >= o.cfg.idleAfterMs;
      const wait = quiet ? o.cfg.idlePollMs : o.cfg.pollMs;
      await sleep(Math.max(wait - elapsed, 0)); // keep ticks aligned
    }
  })().catch((err) => {
    // 内部错误只进日志：SSE 帧对任意浏览器可见，不能带出 SQL/连接串。
    logError("stream", err, { client_id: o.clientId, since });
    o.emit("error", { code: "db_unavailable" });
    stopped = true;
  });

  return {
    stop: () => {
      stopped = true;
    },
  };
}
