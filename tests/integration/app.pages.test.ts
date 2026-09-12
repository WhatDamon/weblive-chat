import { describe, expect, test, afterEach } from "bun:test";
import { makeApp } from "../helpers";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const boot = async () => {
  const h = await makeApp();
  cleanups.push(h.cleanup);
  return h;
};

describe("静态页", () => {
  test("GET / → 302 /demo.html；/demo.html 与 /admin 返回 200 且含关键标记", async () => {
    const { app } = await boot();
    const root = await app.request("/");
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/demo.html");
    const demoRes = await app.request("/demo.html");
    const demo = await demoRes.text();
    expect(demo).toContain('id="messages"');
    expect(demo).toContain("wl.client"); // client_id persistence key
    // copy is injected at response time: no tokens left, window.COPY present
    expect(demo).not.toContain("{{");
    expect(demo).toContain("window.COPY=");
    expect(demo).toContain("window.fill=");
    const adminRes = await app.request("/admin");
    const admin = await adminRes.text();
    expect(admin).toContain('id="pPreviewBtn"');
    expect(admin).toContain("/api/admin/login");
    expect(admin).not.toContain("{{");
    expect(admin).toContain("window.COPY=");
    const alias = await app.request("/admin.html");
    expect(alias.status).toBe(200);
    // Edge cache: repeats must not re-enter the function (instance time is the scarce budget).
    expect(demoRes.headers.get("cache-control")).toContain("s-maxage=");
    expect(adminRes.headers.get("cache-control")).toContain("s-maxage=");
  });

  test("API 响应一律不缓存（/api/meta 含调用方 IP）", async () => {
    const { app } = await boot();
    const meta = await app.request("/api/meta");
    expect(meta.status).toBe(200);
    expect(meta.headers.get("cache-control")).toBe("no-store");
  });
});
