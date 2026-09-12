import { describe, expect, test } from "bun:test";
import { MAX_ID_BOUND } from "../../src/lib/history";
import { parseIdParam } from "../../src/lib/http";

describe("parseIdParam 上界（PG serial/int4 安全）", () => {
  test("合法游标接受；超 MAX_ID_BOUND 的大值夹取而非直入 SQL", () => {
    expect(parseIdParam("5")).toBe(5);
    expect(parseIdParam(String(MAX_ID_BOUND))).toBe(MAX_ID_BOUND);
    // Clamped so an oversized cursor never reaches PG as an int4 argument.
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
    // Rejected: precision loss would yield a wrong cursor.
    expect(parseIdParam("99999999999999999")).toBeNull();
  });
});
