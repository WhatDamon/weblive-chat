import { describe, expect, test, afterEach } from "bun:test";
import { makeApp, readSse, UUID } from "../helpers";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
// memory = 纯内存驱动：不持久化、无外部依赖；单实例内跨功能契约应与 sqlite 一致
const bootMemory = async (over: any = {}) => {
  const h = await makeApp(over, "memory");
  cleanups.push(h.cleanup);
  return h;
};

describe("memory 驱动 app 契约", () => {
  test("收发链路：POST → 历史可见 → meta 正常", async () => {
    const { app } = await bootMemory();
    const post = await app.request("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: UUID, nick: "甲", text: "你好" }),
    });
    expect(post.status).toBe(201);
    const { id } = await post.json();
    const hist = await (await app.request("/api/messages?limit=10")).json();
    expect(hist.messages).toHaveLength(1);
    expect(hist.messages[0]).toMatchObject({
      id: String(id),
      nick: "甲",
      text: "你好",
    });
    expect(hist.mode).toBe("full");
    const meta = await (await app.request("/api/meta")).json();
    expect(meta.limits).toBeDefined();
    await bootMemory();
  });

  test("封禁→禁言不禁看 + 限流在 memory 上一致生效", async () => {
    const { app } = await bootMemory();
    // 默认限流 msgPerMin=10；同 IP 直发不触发限流，先验封禁 403
    const badIp = "6.6.6.6";
    const login = await app.request("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "test-secret" }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const ban = await app.request("/api/admin/bans", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ ip: badIp, reason: "刷屏" }),
    });
    expect(ban.status).toBe(200);
    // 被禁 IP 有效 body → 403（先于限流，不烧预算）
    const banned = await app.request("/api/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": badIp,
      },
      body: JSON.stringify({ client_id: UUID, nick: "n", text: "hi" }),
    });
    expect(banned.status).toBe(403);
    expect((await banned.json()).error.code).toBe("banned");
    // 解禁后可发；限流 1/min 生效 → 第二条 429
    await app.request(`/api/admin/bans/${badIp}`, {
      method: "DELETE",
      headers: { cookie },
    });
    const rateH = await bootMemory({ rate: { msgPerMin: 1 } });
    const ok1 = await rateH.app.request("/api/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": badIp,
      },
      body: JSON.stringify({ client_id: UUID, nick: "n", text: "one" }),
    });
    expect(ok1.status).toBe(201);
    const ok2 = await rateH.app.request("/api/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": badIp,
      },
      body: JSON.stringify({ client_id: UUID, nick: "n", text: "two" }),
    });
    expect(ok2.status).toBe(429);
    expect((await ok2.json()).error.code).toBe("rate_limited");
  });

  test("SSE 流在 memory 上：presence + message 事件可达（含 client_id 计人）", async () => {
    const { app } = await bootMemory();
    const otherUuid = "22222222-2222-4333-8444-555555555555";
    // 客户端 A 开流（此时在线 0→其自身 upsert 后 count=1 → presence 首帧）
    const resA = await app.request(`/api/stream?client_id=${UUID}`, {
      headers: { "x-forwarded-for": "7.7.7.7" },
    });
    expect(resA.status).toBe(200);
    // 流开着 POST → 事件经 memory 轮询推达
    const post = await app.request("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: UUID, nick: "n", text: "流上消息" }),
    });
    expect(post.status).toBe(201);
    const got = await readSse(
      resA,
      (type, data) => type === "message" && data?.text === "流上消息",
      4000,
    );
    const types = got.map((e) => e.type);
    expect(types).toContain("presence"); // 首帧/变化广播
    expect(types).toContain("message");
    const msg = got.find((e) => e.type === "message");
    expect(msg?.data.id).toMatch(/^\d+$/); // 消息 id 序列化为字符串
    // 客户端 B（另一 client_id）开流：count 变化 1→2 → presence 广播 online=2（按 client 计人）
    const resB = await app.request(`/api/stream?client_id=${otherUuid}`, {
      headers: { "x-forwarded-for": "8.8.8.8" },
    });
    const gotB = await readSse(
      resB,
      (type, data) => type === "presence" && data.online === 2,
      4000,
    );
    expect(gotB.some((e) => e.type === "presence" && e.data.online === 2)).toBe(
      true,
    );
  });

  test("存储压力自动降级（ephemeral）在 memory 上：触顶停写历史、广播继续、notice 落 events", async () => {
    const { app, repo } = await bootMemory({
      maxRows: 4,
      maintenanceEvery: 1,
    });
    for (let i = 0; i < 5; i++) {
      const r = await app.request("/api/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: UUID,
          nick: "n",
          text: `t${i}`,
        }),
      });
      expect(r.status).toBe(201);
    }
    // 触顶（retained=maxRows=4）后第 5 次走 ephemeral：不落 messages、广播 id 带 e 前缀
    const stats = await repo.messageStats();
    expect(stats.total).toBe(4);
    const hist = await (await app.request("/api/messages?limit=10")).json();
    expect(hist.messages).toHaveLength(0); // ephemeral 模式读历史返回空
    expect(hist.mode).toBe("ephemeral");
    // notice 事件已广播落 events（含 retention_days）
    const evs = await repo.eventsSince(0, 1000);
    expect(evs.some((e) => e.type === "notice")).toBe(true);
    const last = evs[evs.length - 1];
    expect(last.type).toBe("message");
    expect(JSON.parse(last.payload).id.startsWith("e")).toBe(true);
  });
});
