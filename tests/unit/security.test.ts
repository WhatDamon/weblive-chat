import { describe, expect, test } from "bun:test";
import { normalizeIp, clientIpFromHeaders, normalizeOrigin, parseOriginList, classifyOrigin, signToken, verifyToken } from "../../src/lib/security";

describe("IP", () => {
  test("normalizeIp：trim/小写/非法返回 null", () => {
    expect(normalizeIp(" 1.2.3.4 ")).toBe("1.2.3.4");
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("::ffff:1.2.3.4");
    expect(normalizeIp("not-an-ip")).toBeNull();
    expect(normalizeIp("")).toBeNull();
  });
  test("clientIpFromHeaders：取 x-forwarded-for 首跳，缺失回退", () => {
    expect(clientIpFromHeaders({ "x-forwarded-for": "9.8.7.6, 10.0.0.1" }, "127.0.0.1")).toBe("9.8.7.6");
    expect(clientIpFromHeaders({}, "127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("Origin 白名单", () => {
  test("normalizeOrigin/parseOriginList：去尾斜杠、小写", () => {
    expect(normalizeOrigin("HTTPS://A.com/")).toBe("https://a.com");
    expect(parseOriginList("HTTPS://A.com/, https://b.com")).toEqual(["https://a.com", "https://b.com"]);
  });
  test("classifyOrigin：开放模式 / 白名单 fail-closed / 无 Origin", () => {
    const none: string[] = [];
    expect(classifyOrigin("https://evil.com", none, false).mode).toBe("open");
    const allowed = ["https://a.com", "http://localhost:3000"];
    expect(classifyOrigin("https://a.com", allowed, false)).toEqual({ mode: "allowed", origin: "https://a.com" });
    expect(classifyOrigin("https://evil.com", allowed, false).mode).toBe("denied");
    expect(classifyOrigin(undefined, allowed, false).mode).toBe("no_origin");
    expect(classifyOrigin(undefined, allowed, true)).toEqual({ mode: "denied", code: "missing_origin" });
    expect(classifyOrigin(undefined, none, true).mode).toBe("open");
  });
});

describe("HMAC 会话 Cookie", () => {
  const secret = "very-secret";
  test("sign+verify 往返；篡改/过期/换密钥均拒绝", () => {
    const token = signToken({ sub: "admin", exp: Date.now() + 60_000 }, secret);
    expect(verifyToken(token, secret)).toMatchObject({ sub: "admin" });
    expect(verifyToken(token.slice(0, -2) + "xx", secret)).toBeNull();
    expect(verifyToken(signToken({ sub: "admin", exp: Date.now() - 1 }, secret), secret)).toBeNull();
    expect(verifyToken(signToken({ sub: "admin", exp: Date.now() + 60_000 }, "other"), secret)).toBeNull();
    expect(verifyToken("garbage", secret)).toBeNull();
  });
});
