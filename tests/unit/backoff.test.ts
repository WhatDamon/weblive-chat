import { describe, expect, test } from "bun:test";
import { loadRetryScript } from "../helpers";

// 页面脚本：零构建、无模块系统，函数挂在 globalThis 上，测试执行同一份源码。
loadRetryScript();
const backoffDelay = (globalThis as any).backoffDelay as (
  attempt: number,
  rand: () => number,
) => number;

describe("backoffDelay", () => {
  test("指数增长、封顶 30s、带向下抖动", () => {
    expect(backoffDelay(0, () => 1)).toBe(1000);
    expect(backoffDelay(1, () => 1)).toBe(2000);
    expect(backoffDelay(4, () => 1)).toBe(16000);
    expect(backoffDelay(9, () => 1)).toBe(30000); // 封顶
    expect(backoffDelay(0, () => 0)).toBe(500); // 抖动下界 0.5x
    // 抖动作用在封顶之后：30s × 0.75 —— 若先抖动再封顶，封顶就失效了。
    expect(backoffDelay(10, () => 0.5)).toBe(22500);
  });
});
