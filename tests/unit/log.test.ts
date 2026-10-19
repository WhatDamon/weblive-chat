import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { logError, logInfo, newRequestId } from "../../src/lib/log";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});
function capture() {
  const lines: string[] = [];
  spies.push(
    spyOn(console, "error").mockImplementation((s) => {
      lines.push(String(s));
    }),
  );
  return lines;
}

describe("log", () => {
  test("logError 输出单行 JSON，含 scope/msg/stack 与附加字段", () => {
    const lines = capture();
    logError("chat", new Error("boom"), { request_id: "r1", status: 503 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    const o = JSON.parse(lines[0]);
    expect(o.level).toBe("error");
    expect(o.scope).toBe("chat");
    expect(o.msg).toBe("boom");
    expect(o.stack).toContain("Error: boom");
    expect(o.request_id).toBe("r1");
    expect(o.status).toBe(503);
    expect(typeof o.at).toBe("number");
  });

  test("非 Error 值被字符串化，undefined 字段被丢弃", () => {
    const lines = capture();
    logError("db", "plain string", { request_id: undefined });
    const o = JSON.parse(lines[0]);
    expect(o.msg).toBe("plain string");
    expect("request_id" in o).toBe(false);
  });

  test("logInfo 用 event 而不是 scope", () => {
    const lines = capture();
    logInfo("purge", { scope: "chat", deleted: 3 });
    const o = JSON.parse(lines[0]);
    expect(o.level).toBe("info");
    expect(o.event).toBe("purge");
    expect(o.deleted).toBe(3);
  });

  test("newRequestId 是 UUID", () => {
    expect(newRequestId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("日志永不抛异常：不可序列化的字段降级而不是炸掉请求", () => {
    const lines: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((s) => {
      lines.push(String(s));
    });
    expect(() =>
      // PG 的 bigint 场景：运行时真的可能塞进来一个大整数。
      logError("x", new Error("boom"), { big: 1n as unknown as number }),
    ).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0])).not.toThrow();
    spy.mockRestore();
  });
});
