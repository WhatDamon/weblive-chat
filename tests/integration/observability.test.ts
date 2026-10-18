import { describe, expect, spyOn, test } from "bun:test";
import { createApp } from "../../src/app";
import { metricsSnapshot, resetMetrics } from "../../src/lib/metrics";
import { makeRepo, testCfg } from "../helpers";

describe("可观测性", () => {
  test("存储异常 → 503 + x-request-id + 一行 JSON 日志", async () => {
    const { repo, cleanup } = await makeRepo("memory");
    const lines: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((s) => {
      lines.push(String(s));
    });
    (repo as unknown as Record<string, unknown>).historyBefore = async () => {
      throw new Error("sqlite: disk I/O error");
    };
    const app = createApp({ cfg: testCfg(), repo });
    resetMetrics();

    const res = await app.fetch(new Request("http://x/api/messages"));
    expect(res.status).toBe(503);
    const rid = res.headers.get("x-request-id");
    expect(rid).toMatch(/^[0-9a-f-]{36}$/);

    const logged = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const hit = logged.find(
      (o: Record<string, unknown>) => o.request_id === rid,
    );
    expect(hit).toBeDefined();
    expect(hit!.level).toBe("error");
    expect(String(hit!.msg)).toContain("disk I/O error");
    // 客户端响应不得泄露内部异常
    expect(JSON.stringify(await res.json())).not.toContain("disk I/O error");
    // 计数器是排障入口：503 必须能在指标里看见。
    expect(metricsSnapshot().db_errors).toBeGreaterThanOrEqual(1);
    spy.mockRestore();
    await cleanup();
  });
});
