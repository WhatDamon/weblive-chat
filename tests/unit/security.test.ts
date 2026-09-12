import { describe, expect, test } from "bun:test";
import {
  normalizeIp,
  clientIpFromHeaders,
  normalizeOrigin,
  parseOriginList,
  classifyOrigin,
  signToken,
  verifyToken,
} from "../../src/lib/security";

describe("IP", () => {
  test("normalizeIp：trim/小写/非法返回 null", () => {
    expect(normalizeIp(" 1.2.3.4 ")).toBe("1.2.3.4");
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("::ffff:1.2.3.4");
    expect(normalizeIp("not-an-ip")).toBeNull();
    expect(normalizeIp("")).toBeNull();
  });
  test("clientIpFromHeaders：取 x-forwarded-for 首跳，缺失回退", () => {
    expect(
      clientIpFromHeaders(
        { "x-forwarded-for": "9.8.7.6, 10.0.0.1" },
        "127.0.0.1",
      ),
    ).toBe("9.8.7.6");
    expect(clientIpFromHeaders({}, "127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("Origin 白名单", () => {
  test("normalizeOrigin/parseOriginList：去尾斜杠、小写", () => {
    expect(normalizeOrigin("HTTPS://A.com/")).toBe("https://a.com");
    expect(parseOriginList("HTTPS://A.com/, https://b.com")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });
  test("classifyOrigin：开放模式 / 白名单 fail-closed / 无 Origin", () => {
    const none: string[] = [];
    expect(classifyOrigin("https://evil.com", none, false).mode).toBe("open");
    const allowed = ["https://a.com", "http://localhost:3000"];
    expect(classifyOrigin("https://a.com", allowed, false)).toEqual({
      mode: "allowed",
      origin: "https://a.com",
    });
    expect(classifyOrigin("https://evil.com", allowed, false).mode).toBe(
      "denied",
    );
    expect(classifyOrigin(undefined, allowed, false).mode).toBe("no_origin");
    expect(classifyOrigin(undefined, allowed, true)).toEqual({
      mode: "denied",
      code: "missing_origin",
    });
    expect(classifyOrigin(undefined, none, true).mode).toBe("open");
  });
});

describe("Origin 通配符子域", () => {
  const allowed = ["*.damon233.top"];

  test("*.domain 覆盖主域与任意层级子域（任意 scheme）", () => {
    for (const o of [
      "https://damon233.top",
      "https://livechat.damon233.top",
      "https://a.b.damon233.top",
      "http://damon233.top",
    ])
      expect(classifyOrigin(o, allowed, false)).toEqual({
        mode: "allowed",
        origin: o,
      });
  });

  test("后缀伪装、其它域、非默认端口一律拒绝", () => {
    for (const o of [
      "https://evildamon233.top",
      "https://damon233.top.evil.com",
      "https://xdamon233.top",
      "https://other.top",
      "https://x.damon233.top:8443",
    ])
      expect(classifyOrigin(o, allowed, false).mode).toBe("denied");
  });

  test("带 scheme / 端口的通配符收紧范围；可与精确条目混写", () => {
    const https = ["https://*.damon233.top"];
    expect(classifyOrigin("https://a.damon233.top", https, false).mode).toBe(
      "allowed",
    );
    expect(classifyOrigin("http://a.damon233.top", https, false).mode).toBe(
      "denied",
    );
    const port = ["*.damon233.top:8443"];
    expect(
      classifyOrigin("https://a.damon233.top:8443", port, false).mode,
    ).toBe("allowed");
    expect(classifyOrigin("https://a.damon233.top", port, false).mode).toBe(
      "denied",
    );
    const mixed = ["https://exact.com", "*.damon233.top"];
    expect(classifyOrigin("https://exact.com", mixed, false).mode).toBe(
      "allowed",
    );
    expect(classifyOrigin("https://s.damon233.top", mixed, false).mode).toBe(
      "allowed",
    );
    expect(
      classifyOrigin("https://exact.com.evil.com", mixed, false).mode,
    ).toBe("denied");
  });

  test("非法通配符在解析时就报错（避免静默永不匹配）；IDN 写成 punycode 后匹配", () => {
    for (const bad of [
      "https://*",
      "https://a.*.b.com",
      "*.damon233.top:8a",
      "*x.damon233.top",
      "*.",
    ])
      expect(() => parseOriginList(bad)).toThrow(/ALLOWED_ORIGINS/);
    expect(parseOriginList("*")).toEqual(["*"]);
    expect(
      classifyOrigin(
        "https://a.xn--85x722f.com.cn",
        parseOriginList("*.食狮.com.cn"),
        false,
      ).mode,
    ).toBe("allowed");
  });
});

describe("HMAC 会话 Cookie", () => {
  const secret = "very-secret";
  test("sign+verify 往返；篡改/过期/换密钥均拒绝", () => {
    const token = signToken({ sub: "admin", exp: Date.now() + 60_000 }, secret);
    expect(verifyToken(token, secret)).toMatchObject({ sub: "admin" });
    expect(verifyToken(token.slice(0, -2) + "xx", secret)).toBeNull();
    expect(
      verifyToken(
        signToken({ sub: "admin", exp: Date.now() - 1 }, secret),
        secret,
      ),
    ).toBeNull();
    expect(
      verifyToken(
        signToken({ sub: "admin", exp: Date.now() + 60_000 }, "other"),
        secret,
      ),
    ).toBeNull();
    expect(verifyToken("garbage", secret)).toBeNull();
  });
});
