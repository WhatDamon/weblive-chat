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
    const demo = await (await app.request("/demo.html")).text();
    expect(demo).toContain('id="messages"');
    expect(demo).toContain("wl.client"); // client_id 持久化键
    const admin = await (await app.request("/admin")).text();
    expect(admin).toContain("ADMIN_SECRET");
    expect(admin).toContain("/api/admin/login");
    const alias = await app.request("/admin.html");
    expect(alias.status).toBe(200);
  });
});
