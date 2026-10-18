import { afterEach, describe, expect, test } from "bun:test";
import { makeApp } from "../helpers";
import { clearPageCache, pageCacheStats } from "../../src/routes/pages";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const boot = async () => {
  const h = await makeApp();
  cleanups.push(h.cleanup);
  return h;
};

describe("安全响应头", () => {
  test("API 与页面都有 nosniff / referrer-policy / frame", async () => {
    const { app } = await boot();
    for (const path of ["/api/meta", "/demo.html"]) {
      const res = await app.fetch(new Request(`http://x${path}`));
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("permissions-policy")).toContain("geolocation=()");
    }
  });

  test("页面 CSP 用 hash 放行内联脚本，不含 unsafe-inline", async () => {
    const { app } = await boot();
    const res = await app.fetch(new Request("http://x/demo.html"));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self' 'sha256-");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
  });

  test("页面渲染只读盘一次", async () => {
    const { app } = await boot();
    clearPageCache();
    await app.fetch(new Request("http://x/demo.html"));
    await app.fetch(new Request("http://x/demo.html"));
    expect(pageCacheStats()).toEqual({ hits: 1, misses: 1 });
  });
});
