import { describe, expect, test } from "bun:test";
import { MAX_ID_BOUND } from "../../src/lib/history";
import { parseIdParam } from "../../src/lib/http";

describe("parseIdParam 上界（PG serial/int4 安全）", () => {
  test("合法游标接受；超 MAX_ID_BOUND 的大值夹取而非直入 SQL", () => {
    expect(parseIdParam("5")).toBe(5);
    expect(parseIdParam(String(MAX_ID_BOUND))).toBe(MAX_ID_BOUND);
    // 超过 int4 上界（但仍在安全整数内）的游标：夹取到 MAX_ID_BOUND，
    // 保证不把超大值作为 `id < ?` 实参发往 PG（执行期 out of range）
    expect(parseIdParam(String(MAX_ID_BOUND + 1))).toBe(MAX_ID_BOUND);
    expect(parseIdParam(String(Number.MAX_SAFE_INTEGER))).toBe(MAX_ID_BOUND);
  });

  test("非法输入 → null：非数字/空/小数/负/零/超安全整数", () => {
    expect(parseIdParam(undefined)).toBeNull();
    expect(parseIdParam("")).toBeNull();
    expect(parseIdParam("abc")).toBeNull();
    expect(parseIdParam("1.5")).toBeNull();
    expect(parseIdParam("-1")).toBeNull();
    expect(parseIdParam("0")).toBeNull();
    // 超 MAX_SAFE_INTEGER（位数过长）拒绝，避免精度丢失后的错误游标
    expect(parseIdParam("99999999999999999")).toBeNull();
  });
});
