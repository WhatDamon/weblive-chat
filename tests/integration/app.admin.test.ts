import { describe, expect, test, afterEach } from "bun:test";
import { makeApp, UUID } from "../helpers";

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const boot = async (over: any = {}) => { const h = await makeApp(over); cleanups.push(h.cleanup); return h; };

describe("admin API", () => {
  test("未登录访问 → 401；错误口令 → 401 invalid_secret；正确口令发 cookie", async () => {
    const { app } = await boot();
    let res = await app.request("/api/admin/stats");
    expect(res.status).toBe(401);
    res = await app.request("/api/admin/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "1.1.1.1" }, body: JSON.stringify({ secret: "wrong" }) });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("invalid_secret");
    res = await app.request("/api/admin/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "1.1.1.1" }, body: JSON.stringify({ secret: "test-secret" }) });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("wl_admin=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    // 用 cookie 访问
    res = await app.request("/api/admin/stats", { headers: { cookie: setCookie.split(";")[0] } });
    expect(res.status).toBe(200);
  });

  test("封禁流程：列表→新增→再次新增幂等→删除", async () => {
    const { app } = await boot();
    const login = await app.request("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: "test-secret" }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const auth = (extra: Record<string, string> = {}) => ({ cookie, ...extra });
    // 简报硬伤修正（机械）：请求体必须置于 init 顶层，content-type 归入 headers
    const postBan = (ip: string, reason: string) =>
      app.request("/api/admin/bans", {
        method: "POST",
        headers: auth({ "content-type": "application/json" }),
        body: JSON.stringify({ ip, reason }),
      });
    let res = await postBan("6.6.6.6", "刷屏");
    expect(res.status).toBe(200);
    expect((await res.json()).created).toBe(true);
    res = await postBan("6.6.6.6", "再刷");
    expect((await res.json()).created).toBe(false);
    const list = await (await app.request("/api/admin/bans", { headers: auth() })).json();
    expect(list.bans[0]).toMatchObject({ ip: "6.6.6.6", reason: "再刷" });
    res = await app.request("/api/admin/bans/6.6.6.6", { method: "DELETE", headers: auth() });
    expect(res.status).toBe(204);
    const after = await (await app.request("/api/admin/bans", { headers: auth() })).json();
    expect(after.bans).toHaveLength(0);
  });

  test("封禁列表 limit/offset 只收整数：12.5/负数 → 400 invalid_cursor（非 503）", async () => {
    const { app } = await boot();
    const login = await app.request("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "test-secret" }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const res = await app.request("/api/admin/bans?limit=12.5&offset=-1", {
      headers: { cookie },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_cursor");
    const ok = await app.request("/api/admin/bans?limit=1&offset=0", {
      headers: { cookie },
    });
    expect(ok.status).toBe(200);
  });

  test("删消息：软删占位广播 delete 事件；不存在 → 404", async () => {
    const { app } = await boot();
    const post = await app.request("/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: UUID, nick: "n", text: "待删" }) });
    const { id } = await post.json();
    const login = await app.request("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: "test-secret" }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    let res = await app.request(`/api/admin/messages/${id}`, { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(204);
    const hist = await (await app.request("/api/messages?limit=10")).json();
    const row = hist.messages.find((m: any) => m.id === id);
    expect(row).toMatchObject({ deleted: true, text: null });
    res = await app.request(`/api/admin/messages/${id}`, { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(404);
  });

  test("stats：含 online / messages_total / history", async () => {
    const { app } = await boot();
    const login = await app.request("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: "test-secret" }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const stats = await (await app.request("/api/admin/stats", { headers: { cookie } })).json();
    expect(stats).toMatchObject({ messages_total: 0 });
    expect(typeof stats.online).toBe("number");
    expect(stats.history.mode).toBe("full");
  });
});
