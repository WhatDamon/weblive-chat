import { describe, expect, test } from "bun:test";
import {
  decideHistory,
  performMaintenance,
  RETENTION_LADDER_DAYS,
} from "../../src/lib/history";

const cfg = { retentionDays: 90, maxRows: 1000 };

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
    // 基线 7 天 < 首档 30：占比 ≥50% 也不得把保留期拉长到 30 → 保持基线 full
    const r1 = decideHistory(
      { retained: 600 },
      { retentionDays: 7, maxRows: 1000 },
    );
    expect(r1).toEqual({ mode: "full", retentionDays: 7 });
    // 基线 45 天（介于 30 与 90 之间）：命中 0.5 档仍应收缩到 30
    const r2 = decideHistory(
      { retained: 600 },
      { retentionDays: 45, maxRows: 1000 },
    );
    expect(r2).toEqual({ mode: "degraded_retention", retentionDays: 30 });
  });
});

describe("performMaintenance", () => {
  test("四阶段顺序：清理→档位删超龄→超行数裁剪→重算档位", async () => {
    const T = 1_800_000_000_000; // 固定 now，便于断言裁剪 cutoff
    const DAY = 86_400_000;
    const order: string[] = [];
    const statsSeq = [5, 5, 2]; // messageStats 序列：初始 → 删超龄后(仍超上限) → trim 后
    let i = 0;
    let dayCutoff = 0;
    let floor = 0;
    const repo = {
      cleanupEvents: async () => {
        order.push("cleanupEvents");
        return 1;
      },
      cleanupPresence: async () => {
        order.push("cleanupPresence");
        return 2;
      },
      cleanupRateLimits: async () => {
        order.push("cleanupRateLimits");
        return 3;
      },
      messageStats: async () => {
        order.push("messageStats");
        const r = statsSeq[Math.min(i, statsSeq.length - 1)];
        i++;
        return { total: r, retained: r };
      },
      deleteMessagesOlderThan: async (cutoff: number) => {
        order.push("deleteMessagesOlderThan");
        dayCutoff = cutoff;
        return 5;
      },
      historyBefore: async () => {
        order.push("historyBefore");
        return [{ id: 102 }, { id: 101 }, { id: 100 }]; // 排序约定 id DESC（最新在前）
      },
      trimMessagesBelow: async (f: number) => {
        order.push("trimMessagesBelow");
        floor = f;
        return 2;
      },
    };
    const res = await performMaintenance(
      {
        repo: repo as any,
        cfg: {
          maxRows: 3,
          retentionDays: 90,
          presenceTtlMs: 45_000,
          eventsTtlMs: 3_600_000,
          maintenanceEvery: 100,
        },
      },
      T,
    );
    expect(order).toEqual([
      "cleanupEvents",
      "cleanupPresence",
      "cleanupRateLimits",
      "messageStats",
      "deleteMessagesOlderThan",
      "messageStats",
      "historyBefore",
      "trimMessagesBelow",
      "messageStats",
    ]);
    expect(dayCutoff).toBe(T - DAY); // 初始 retained≥maxRows → ephemeral 档 1 天
    expect(floor).toBe(100); // 第 3 新（DESC 最新在前 → 末位为最旧保留）
    expect(res).toEqual({
      mode: "degraded_retention",
      retentionDays: 30,
      deleted: 7,
    });
  });
});
