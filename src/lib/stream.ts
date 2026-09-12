import type { EventRow } from "./repo";

export interface StreamRepo {
  eventsSince(since: number, limit: number): Promise<EventRow[]>;
  eventsMaxId(): Promise<number>;
  presenceUpsert(clientId: string, at: number): Promise<void>;
  presenceCount(cutoff: number): Promise<number>;
  banGet(ip: string): Promise<{ reason: string } | null>;
}

export interface StreamCfg {
  pollMs: number;
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
      // Cursor fallback: events behind the cursor were already purged, so restart from max id.
      const maxId = await o.repo.eventsMaxId();
      if (since > maxId) since = Math.max(maxId, 0);
      rows = await o.repo.eventsSince(since, 100);
    }
    let pushed = 0;
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
    // lastSent only advances on real writes, so an idle stream still reaches the heartbeat.
    if (pushed > 0) lastSent = Date.now();
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
      await sleep(Math.max(o.cfg.pollMs - elapsed, 0)); // keep ticks aligned
    }
  })().catch((err) => {
    o.emit("error", { code: "db_unavailable", message: String(err) });
    stopped = true;
  });

  return {
    stop: () => {
      stopped = true;
    },
  };
}
