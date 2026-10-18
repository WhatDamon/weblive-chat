import { describe, expect, test } from "bun:test";
import {
  decideHistory,
  newHistoryState,
  performMaintenance,
  RETENTION_LADDER_DAYS,
} from "../../src/lib/history";

const cfg = { retentionDays: 90, maxRows: 1000 };
/** 维护依赖的本地工厂：记录每个被调用的方法名，供顺序断言。 */
function historyDeps(over: Record<string, any> = {}) {
  const calls: string[] = [];
  const repo = {
    cleanupEvents: async () => {
      calls.push("cleanupEvents");
      return 0;
    },
    cleanupPresence: async () => {
      calls.push("cleanupPresence");
      return 0;
    },
    cleanupRateLimits: async () => {
      calls.push("cleanupRateLimits");
      return 0;
    },
    messageStats: async () => {
      calls.push("messageStats");
      return { total: 0, retained: 0 };
    },
    deleteMessagesOlderThan: async () => {
      calls.push("deleteMessagesOlderThan");
      return 0;
    },
    idAtOffset: async () => {
      calls.push("idAtOffset");
      return null;
    },
    trimMessagesBelow: async () => {
      calls.push("trimMessagesBelow");
      return 0;
    },
    ...over,
  };
  return {
    calls,
    deps: {
      repo: repo as any,
      cfg: {
        maxRows: 3,
        retentionDays: 90,
        presenceTtlMs: 45_000,
        eventsTtlMs: 3_600_000,
        statsTtlMs: 60_000,
        maintenanceEvery: 100,
      },
      state: newHistoryState(),
    },
  };
}

describe("newHistoryState", () => {
  test("不再携带 writeCount（维护计数已交给 lib/maintenance.ts，双份计数只会漂移）", () => {
    expect("writeCount" in newHistoryState()).toBe(false);
  });
});

describe("decideHistory", () => {
  test("远低于上限 → full 且保留配置天数", () => {
    expect(decideHistory({ retained: 100 }, cfg)).toEqual({
      mode: "full",
      retentionDays: 90,
    });
  });
  test("随行数增长逐级收缩：0.5→90…；阶梯常量正确", () => {
    expect(RETENTION_LADDER_DAYS).toEqual([90, 30, 10, 3, 1]);
    expect(decideHistory({ retained: 600 }, cfg).retentionDays).toBe(30); // ≥50%
    expect(decideHistory({ retained: 800 }, cfg).retentionDays).toBe(10); // ≥70%
    expect(decideHistory({ retained: 900 }, cfg).retentionDays).toBe(3); // ≥85%
    expect(decideHistory({ retained: 960 }, cfg).retentionDays).toBe(1); // ≥95%
  });
  test("触顶 → ephemeral", () => {
    expect(decideHistory({ retained: 1000 }, cfg)).toEqual({
      mode: "ephemeral",
      retentionDays: 1,
    });
    expect(decideHistory({ retained: 1200 }, cfg).mode).toBe("ephemeral");
  });
  test("degraded_retention 标记出现在天数已降时", () => {
    const r = decideHistory({ retained: 600 }, cfg);
    expect(r.mode).toBe("degraded_retention");
    expect(decideHistory({ retained: 100 }, cfg).mode).toBe("full");
  });
  test("cfg.retentionDays 低于阶梯首档时永不反向升档（Math.min 保护）", () => {
    // Baseline below the first ladder step must never lengthen retention.
    const r1 = decideHistory(
      { retained: 600 },
      { retentionDays: 7, maxRows: 1000 },
    );
    expect(r1).toEqual({ mode: "full", retentionDays: 7 });
    const r2 = decideHistory(
      { retained: 600 },
      { retentionDays: 45, maxRows: 1000 },
    );
    expect(r2).toEqual({ mode: "degraded_retention", retentionDays: 30 });
  });
});

describe("performMaintenance", () => {
  test("四阶段顺序：清理→档位删超龄→超行数裁剪→重算档位", async () => {
    const T = 1_800_000_000_000; // Fixed now so the cutoff assertion is deterministic
    const DAY = 86_400_000;
    let dayCutoff = 0;
    let floor = 0;
    // 5 行 → 删掉 1 行超龄（4）→ 仍超上限 → 裁掉 2 行（2）→ 2/3 落在降档区间。
    const { calls, deps } = historyDeps({
      messageStats: async () => {
        calls.push("messageStats");
        return { total: 5, retained: 5 };
      },
      deleteMessagesOlderThan: async (cutoff: number) => {
        calls.push("deleteMessagesOlderThan");
        dayCutoff = cutoff;
        return 1;
      },
      idAtOffset: async (offset: number) => {
        calls.push("idAtOffset");
        // 第 maxRows 新的 id（maxRows=3、offset=2）就是裁剪边界。
        expect(offset).toBe(2);
        return 100;
      },
      trimMessagesBelow: async (f: number) => {
        calls.push("trimMessagesBelow");
        floor = f;
        return 2;
      },
    });
    const res = await performMaintenance(deps, T);
    // COUNT 只发生一次：删除量靠差值折算，不再每步重数一遍。
    expect(calls).toEqual([
      "cleanupEvents",
      "cleanupPresence",
      "cleanupRateLimits",
      "messageStats",
      "deleteMessagesOlderThan",
      "idAtOffset",
      "trimMessagesBelow",
    ]);
    expect(dayCutoff).toBe(T - DAY); // retained >= maxRows initially → 1-day tier
    expect(floor).toBe(100); // 3rd newest id = oldest row kept
    expect(res).toEqual({
      mode: "degraded_retention",
      retentionDays: 30,
      deleted: 3,
    });
  });

  test("删除量大于缓存行数时折算夹到 0，不出现负数档位", async () => {
    const { deps } = historyDeps({
      messageStats: async () => ({ total: 10, retained: 10 }),
      deleteMessagesOlderThan: async () => 99,
    });
    const res = await performMaintenance(deps, 1_000);
    expect(res.mode).toBe("full");
    expect(res.deleted).toBe(99);
  });

  test("60s 内多次维护只 COUNT 一次", async () => {
    let statsCalls = 0;
    const { deps } = historyDeps({
      messageStats: async () => {
        statsCalls += 1;
        return { total: 5, retained: 5 };
      },
    });
    await performMaintenance(deps, 1_000);
    await performMaintenance(deps, 2_000);
    await performMaintenance(deps, 3_000);
    expect(statsCalls).toBe(1);
  });

  test("触顶裁剪不调用 historyBefore（不再整表读）", async () => {
    const { deps, calls } = historyDeps({
      messageStats: async () => ({ total: 5, retained: 5 }),
      idAtOffset: async () => {
        calls.push("idAtOffset");
        return 3;
      },
      trimMessagesBelow: async () => {
        calls.push("trimMessagesBelow");
        return 2;
      },
    });
    await performMaintenance(deps, 1_000);
    expect(calls.filter((c) => c === "idAtOffset")).toHaveLength(1);
    expect(calls).not.toContain("historyBefore");
  });
});
