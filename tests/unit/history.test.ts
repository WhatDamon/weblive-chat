import { describe, expect, test } from "bun:test";
import { decideHistory, RETENTION_LADDER_DAYS } from "../../src/lib/history";

const cfg = { retentionDays: 90, maxRows: 1000 };

describe("decideHistory", () => {
  test("远低于上限 → full 且保留配置天数", () => {
    expect(decideHistory({ retained: 100 }, cfg)).toEqual({ mode: "full", retentionDays: 90 });
  });
  test("随行数增长逐级收缩：0.5→90…；阶梯常量正确", () => {
    expect(RETENTION_LADDER_DAYS).toEqual([90, 30, 10, 3, 1]);
    expect(decideHistory({ retained: 600 }, cfg).retentionDays).toBe(30);  // ≥50%
    expect(decideHistory({ retained: 800 }, cfg).retentionDays).toBe(10);  // ≥70%
    expect(decideHistory({ retained: 900 }, cfg).retentionDays).toBe(3);   // ≥85%
    expect(decideHistory({ retained: 960 }, cfg).retentionDays).toBe(1);   // ≥95%
  });
  test("触顶 → ephemeral", () => {
    expect(decideHistory({ retained: 1000 }, cfg)).toEqual({ mode: "ephemeral", retentionDays: 1 });
    expect(decideHistory({ retained: 1200 }, cfg).mode).toBe("ephemeral");
  });
  test("degraded_retention 标记出现在天数已降时", () => {
    const r = decideHistory({ retained: 600 }, cfg);
    expect(r.mode).toBe("degraded_retention");
    expect(decideHistory({ retained: 100 }, cfg).mode).toBe("full");
  });
});
