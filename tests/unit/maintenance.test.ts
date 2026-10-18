import { describe, expect, test } from "bun:test";
import { createMaintenance } from "../../src/lib/maintenance";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createMaintenance", () => {
  test("hit() 不阻塞；到阈值后台跑一次；flush() 等待完成", async () => {
    let runs = 0;
    const m = createMaintenance({
      every: 3,
      run: async () => {
        runs += 1;
        await sleep(5);
      },
    });
    m.hit(1);
    m.hit(2);
    expect(runs).toBe(0);
    m.hit(3);
    expect(runs).toBe(1); // 已启动，但 hit() 没有 await
    await m.flush();
    expect(runs).toBe(1);
  });

  test("运行期间的写入会补偿触发一次（合并，不丢）", async () => {
    let runs = 0;
    const m = createMaintenance({
      every: 1,
      run: async () => {
        runs += 1;
        await sleep(5);
      },
    });
    m.hit(1);
    m.hit(2);
    m.hit(3);
    await m.flush();
    // 第一次触发在运行中，三次 hit 合并成第二次触发：共 2 次，且不会饿死到 0 次。
    expect(runs).toBe(2);
  });

  test("run 抛错不会让调度器卡死，错误交给 onError", async () => {
    const errs: unknown[] = [];
    let runs = 0;
    const m = createMaintenance({
      every: 1,
      run: async () => {
        runs += 1;
        throw new Error("db down");
      },
      onError: (e) => errs.push(e),
    });
    m.hit(1);
    await m.flush();
    m.hit(2);
    await m.flush();
    expect(runs).toBe(2);
    expect(errs).toHaveLength(2);
  });
});
