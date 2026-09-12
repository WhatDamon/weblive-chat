import { describe, expect, test, afterEach } from "bun:test";
import { makeApp, UUID } from "../helpers";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const boot = async (over: any = {}) => {
  const h = await makeApp(over);
  cleanups.push(h.cleanup);
  return h;
};

describe("admin API", () => {
  test("未登录访问 → 401；错误口令 → 401 invalid_secret；正确口令发 cookie", async () => {
    const { app } = await boot();
    let res = await app.request("/api/admin/stats");
    expect(res.status).toBe(401);
    res = await app.request("/api/admin/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "1.1.1.1",
      },
      body: JSON.stringify({ secret: "wrong" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("invalid_secret");
    res = await app.request("/api/admin/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "1.1.1.1",
      },
      body: JSON.stringify({ secret: "test-secret" }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("wl_admin=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    res = await app.request("/api/admin/stats", {
      headers: { cookie: setCookie.split(";")[0] },
    });
    expect(res.status).toBe(200);
  });

  test("封禁流程：列表→新增→再次新增幂等→删除", async () => {
    const { app } = await boot();
    const login = await app.request("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "test-secret" }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const auth = (extra: Record<string, string> = {}) => ({ cookie, ...extra });
    // body goes at the init top level; content-type belongs in headers
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
    const list = await (
      await app.request("/api/admin/bans", { headers: auth() })
    ).json();
    expect(list.bans[0]).toMatchObject({ ip: "6.6.6.6", reason: "再刷" });
    res = await app.request("/api/admin/bans/6.6.6.6", {
      method: "DELETE",
      headers: auth(),
    });
    expect(res.status).toBe(204);
    const after = await (
      await app.request("/api/admin/bans", { headers: auth() })
    ).json();
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
    const post = await app.request("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: UUID, nick: "n", text: "待删" }),
    });
    const { id } = await post.json();
    const login = await app.request("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "test-secret" }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    let res = await app.request(`/api/admin/messages/${id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(204);
    const hist = await (await app.request("/api/messages?limit=10")).json();
    const row = hist.messages.find((m: any) => m.id === id);
    expect(row).toMatchObject({ deleted: true, text: null });
    res = await app.request(`/api/admin/messages/${id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  test("stats：含 online / messages_total / history", async () => {
    const { app } = await boot();
    const login = await app.request("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "test-secret" }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const stats = await (
      await app.request("/api/admin/stats", { headers: { cookie } })
    ).json();
    expect(stats).toMatchObject({ messages_total: 0 });
    expect(typeof stats.online).toBe("number");
    expect(stats.history.mode).toBe("full");
  });
});

describe("危险操作：清空数据（多重校验）", () => {
  const PURGE_RATE = {
    msgPerMin: 10,
    streamPerMin: 20,
    loginPerMin: 5,
    purgePerMin: 10,
    windowMs: 60_000,
  };
  const IP = "1.1.1.1";
  const bootPurge = (extra: any = {}) => boot({ rate: PURGE_RATE, ...extra });
  const login = async (app: any) => {
    const res = await app.request("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "test-secret" }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0];
  };
  const hdr = (cookie: string, ip = IP) => ({
    cookie,
    "content-type": "application/json",
    "x-forwarded-for": ip,
  });
  const preview = (app: any, cookie: string, scope: string) =>
    app.request("/api/admin/purge/preview", {
      method: "POST",
      headers: hdr(cookie),
      body: JSON.stringify({ scope }),
    });
  const commit = (app: any, cookie: string, body: unknown, ip = IP) =>
    app.request("/api/admin/purge", {
      method: "POST",
      headers: hdr(cookie, ip),
      body: JSON.stringify(body),
    });
  const seedMsg = (app: any, text = "seed") =>
    app.request("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: UUID, nick: "n", text }),
    });
  const listBans = async (app: any, cookie: string) =>
    (
      await (
        await app.request("/api/admin/bans", { headers: { cookie } })
      ).json()
    ).bans;

  test("预检：未登录 401；scope 非法 400；合法则返回影响面 / 短语 / 令牌", async () => {
    const { app } = await bootPurge();
    let res = await app.request("/api/admin/purge/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "chat" }),
    });
    expect(res.status).toBe(401);
    const cookie = await login(app);
    res = await preview(app, cookie, "all");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_body");
    await seedMsg(app);
    res = await preview(app, cookie, "chat");
    expect(res.status).toBe(200);
    const p = await res.json();
    expect(p).toMatchObject({
      scope: "chat",
      confirm_phrase: "清空聊天记录",
      will_delete: ["messages", "events"],
    });
    expect(p.counts.messages).toBe(1);
    expect(p.counts.events).toBe(1);
    expect(typeof p.token).toBe("string");
    expect(p.expires_at).toBeGreaterThan(Date.now());
  });

  test("执行：缺口令 / 错口令 → 401；短语不符 → 400 invalid_confirm", async () => {
    const { app } = await bootPurge();
    const cookie = await login(app);
    await seedMsg(app);
    const p = await (await preview(app, cookie, "chat")).json();
    let res = await commit(app, cookie, {
      scope: "chat",
      token: p.token,
      confirm: p.confirm_phrase,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("invalid_secret");
    res = await commit(app, cookie, {
      scope: "chat",
      token: p.token,
      confirm: p.confirm_phrase,
      secret: "nope",
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("invalid_secret");
    res = await commit(app, cookie, {
      scope: "chat",
      token: p.token,
      confirm: "清空聊天",
      secret: "test-secret",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_confirm");
    expect(
      (await (await app.request("/api/messages?limit=5")).json()).messages,
    ).toHaveLength(1);
  });

  test("令牌：篡改 / 换 IP / 二次使用均拒；正确链路 200 并真正清空", async () => {
    const { app } = await bootPurge();
    const cookie = await login(app);
    await seedMsg(app);
    const p = await (await preview(app, cookie, "chat")).json();
    let res = await commit(app, cookie, {
      scope: "chat",
      token: `${p.token}x`,
      confirm: p.confirm_phrase,
      secret: "test-secret",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_token");
    // token is bound to the requesting IP
    res = await commit(
      app,
      cookie,
      {
        scope: "chat",
        token: p.token,
        confirm: p.confirm_phrase,
        secret: "test-secret",
      },
      "2.2.2.2",
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_token");
    res = await commit(app, cookie, {
      scope: "chat",
      token: p.token,
      confirm: p.confirm_phrase,
      secret: "test-secret",
    });
    expect(res.status).toBe(200);
    const ok = await res.json();
    expect(ok.scope).toBe("chat");
    expect(ok.deleted.messages).toBe(1);
    expect(ok.deleted.events).toBe(1);
    expect(
      (await (await app.request("/api/messages?limit=5")).json()).messages,
    ).toHaveLength(0);
    res = await commit(app, cookie, {
      scope: "chat",
      token: p.token,
      confirm: p.confirm_phrase,
      secret: "test-secret",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_token");
  });

  test("效果：chat 档保留封禁名单，full 档连封禁一起清", async () => {
    const { app } = await bootPurge();
    const cookie = await login(app);
    await seedMsg(app);
    await app.request("/api/admin/bans", {
      method: "POST",
      headers: hdr(cookie),
      body: JSON.stringify({ ip: "6.6.6.6", reason: "保留验证" }),
    });
    expect(await listBans(app, cookie)).toHaveLength(1);

    const p1 = await (await preview(app, cookie, "chat")).json();
    expect(p1.counts.bans).toBe(1);
    expect(p1.will_delete).toEqual(["messages", "events"]);
    const r1 = await commit(app, cookie, {
      scope: "chat",
      token: p1.token,
      confirm: p1.confirm_phrase,
      secret: "test-secret",
    });
    expect(r1.status).toBe(200);
    expect((await r1.json()).deleted.bans).toBe(0);
    expect(
      (await (await app.request("/api/messages?limit=5")).json()).messages,
    ).toHaveLength(0);
    expect(await listBans(app, cookie)).toHaveLength(1);

    const p2 = await (await preview(app, cookie, "full")).json();
    expect(p2.confirm_phrase).toBe("清空全部数据");
    expect(p2.will_delete).toEqual([
      "messages",
      "events",
      "presence",
      "rate_limits",
      "bans",
    ]);
    const r2 = await commit(app, cookie, {
      scope: "full",
      token: p2.token,
      confirm: p2.confirm_phrase,
      secret: "test-secret",
    });
    expect(r2.status).toBe(200);
    expect((await r2.json()).deleted.bans).toBe(1);
    expect(await listBans(app, cookie)).toHaveLength(0);
  });

  test("限流：预检与执行共用同一桶，超限 429", async () => {
    const { app } = await bootPurge({
      rate: { ...PURGE_RATE, purgePerMin: 2 },
    });
    const cookie = await login(app);
    expect((await preview(app, cookie, "chat")).status).toBe(200);
    expect((await preview(app, cookie, "chat")).status).toBe(200);
    const res = await preview(app, cookie, "chat");
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("rate_limited");
  });
});
