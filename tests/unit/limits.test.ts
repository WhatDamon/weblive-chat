import { describe, expect, test } from "bun:test";
import { rateCheck } from "../../src/lib/limits";

function fakeRate(seq: number[]) {
  let i = 0;
  return { rateHit: async () => seq[Math.min(i++, seq.length - 1)] };
}
const now = 60_500; // 对齐后窗口起点 60_000

describe("rateCheck", () => {
  test("未超限 allowed；第 limit+1 次拒绝并给 retry_after_ms", async () => {
    const repo = fakeRate([1, 2, 3]);
    // rateCheck 恒返三字段（allowed 时 retryAfterMs 也计算好供前端展示/预跳）→ 用 toMatchObject 断言关键字段
    expect(
      await rateCheck(repo as any, "msg", "9.9.9.9", 2, now),
    ).toMatchObject({ allowed: true, count: 1 });
    expect(
      await rateCheck(repo as any, "msg", "9.9.9.9", 2, now),
    ).toMatchObject({ allowed: true, count: 2 });
    const r = await rateCheck(repo as any, "msg", "9.9.9.9", 2, now);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBe(59_500); // 60000+60000-60500
  });
  test("窗口按 60s 对齐传给 rateHit", async () => {
    let seen = 0;
    const repo = {
      rateHit: async (_b: string, _s: string, ws: number) => {
        seen = ws;
        return 1;
      },
    };
    await rateCheck(repo as any, "stream", "1.1.1.1", 5, 61_234);
    expect(seen).toBe(60_000);
  });
});
