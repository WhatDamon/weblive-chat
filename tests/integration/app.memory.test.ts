import { describe, expect, test, afterEach } from "bun:test";
import { makeApp, readSse, UUID } from "../helpers";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
// memory driver: in-process only, and it must satisfy the same contract as sqlite
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
    // the ban check runs before rate limiting, so no budget is spent
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
    // A opens first: its own upsert makes count=1, so a presence frame is emitted
    const resA = await app.request(`/api/stream?client_id=${UUID}`, {
      headers: { "x-forwarded-for": "7.7.7.7" },
    });
    expect(resA.status).toBe(200);
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
    expect(types).toContain("presence");
    expect(types).toContain("message");
    const msg = got.find((e) => e.type === "message");
    expect(msg?.data.id).toMatch(/^\d+$/); // ids are serialized as strings
    // B uses another client_id: count 1→2, presence reports online=2
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
    // at the row cap the 5th write goes ephemeral: no messages row, e-prefixed id
    const stats = await repo.messageStats();
    expect(stats.total).toBe(4);
    const hist = await (await app.request("/api/messages?limit=10")).json();
    expect(hist.messages).toHaveLength(0);
    expect(hist.mode).toBe("ephemeral");
    const evs = await repo.eventsSince(0, 1000);
    expect(evs.some((e) => e.type === "notice")).toBe(true);
    const last = evs[evs.length - 1];
    expect(last.type).toBe("message");
    expect(JSON.parse(last.payload).id.startsWith("e")).toBe(true);
  });
});
