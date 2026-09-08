import { describe, expect, test } from "bun:test";
import { runStream } from "../../src/lib/stream";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function fakeRepo(over: Record<string, any> = {}) {
  const events: any[] = over.events ?? [];
  const state = { since: 0, upserts: 0, counts: 0, maxId: over.maxId ?? 0, ban: over.ban ?? null, seen: [] as string[] };
  return {
    state,
    repo: {
      eventsSince: async (since: number) => events.filter(e => e.id > since).slice(0, 100),
      eventsMaxId: async () => state.maxId,
      presenceUpsert: async () => { state.upserts++; },
      presenceCount: async () => state.counts++ === 0 ? 1 : 1, // 固定 1 → 只在首推变化
      banGet: async () => state.ban,
    } as any,
  };
}

const cfg = { pollMs: 2, presenceUpsertMs: 2, presenceCountMs: 2, heartbeatMs: 1_000_000, presenceTtlMs: 45_000 } as any;

describe("runStream", () => {
  test("推送已有 events、presence 初值、并前进游标", async () => {
    const f = fakeRepo({ events: [{ id: 1, type: "message", payload: JSON.stringify({ id: 99 }), created_at: 1 }] });
    const out: [string, unknown][] = [];
    const ctrl = runStream({ repo: f.repo, cfg, clientId: "c1", emit: (t, d) => out.push([t, d]) });
    await sleep(10);
    ctrl.stop();
    const types = out.map(o => o[0]);
    expect(types).toContain("message");
    expect(types).toContain("presence");
    expect(f.state.upserts).toBeGreaterThan(0);
  });

  test("presence 计数变化才广播（两次计数相同只推一次）", async () => {
    let online = 1;
    const f = fakeRepo();
    f.repo.presenceCount = async () => online;
    const out: [string, unknown][] = [];
    const ctrl = runStream({ repo: f.repo, cfg, clientId: "c1", emit: (t, d) => out.push([t, d]) });
    await sleep(8);
    online = 2;
    await sleep(8);
    ctrl.stop();
    const pres = out.filter(o => o[0] === "presence");
    expect(pres.length).toBe(2);
    expect((pres[1][1] as any).online).toBe(2);
  });

  test("命中禁言：开流先发 ban 提示（流不关闭）", async () => {
    const f = fakeRepo({ ban: { reason: "spam" } });
    const out: [string, unknown][] = [];
    const ctrl = runStream({ repo: f.repo, cfg: { ...cfg, ip: "9.9.9.9" }, clientId: "c1", emit: (t, d) => out.push([t, d]) });
    await sleep(6);
    ctrl.stop();
    expect(out[0]).toEqual(["ban", { reason: "spam" }]);
  });

  test("游标落后（events 已清理）→ 重置到 maxId 后继续收到新事件", async () => {
    const f = fakeRepo({ maxId: 50 });
    const out: [string, unknown][] = [];
    // 场景：cursor=100，但 events 只保留到 50（已清理）→ 空转检测后重置为 50，随后新事件 101 到达
    f.repo.eventsSince = async (since: number) => {
      if (since >= 100) return [];
      if (since >= 50) return [{ id: 101, type: "message", payload: JSON.stringify({ id: "101", text: "new" }), created_at: 1 }];
      return [];
    };
    const ctrl = runStream({ repo: f.repo, cfg, clientId: "c1", since: 100, emit: (t, d) => out.push([t, d]) });
    await sleep(8);
    ctrl.stop();
    expect(out.some(o => o[0] === "message" && (o[1] as any).id === "101")).toBe(true); // 重置后 101 被推
  });
});
