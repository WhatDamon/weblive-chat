import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeApp, readSse, UUID } from "../helpers";

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const boot = async (over: any = {}) => {
  const h = await makeApp(over);
  cleanups.push(h.cleanup);
  return h;
};

describe("chat 公开端点", () => {
  test("meta：限额/presence/client_ip，无 DB 也可用", async () => {
    const { app } = await boot();
    const res = await app.request("/api/meta", {
      headers: { "x-forwarded-for": "9.9.9.9" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limits).toEqual({
      nick_max: 24,
      text_max: 1000,
      retention_days: 90,
    });
    expect(body.presence.ttl_s).toBe(45);
    expect(body.client_ip).toBe("9.9.9.9");
  });

  test("POST 消息 → 201；历史回溯 before/since 视图一致", async () => {
    const { app } = await boot();
    const post = async (i: number) => {
      const res = await app.request("/api/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "1.2.3.4",
        },
        body: JSON.stringify({ client_id: UUID, nick: "甲", text: `第${i}条` }),
      });
      expect(res.status).toBe(201);
      return (await res.json()) as { id: string; created_at: string };
    };
    const a = await post(1);
    const b = await post(2);
    const latest = await app.request("/api/messages?limit=10");
    const lb = await latest.json();
    expect(lb.messages[0]).toMatchObject({
      id: b.id,
      nick: "甲",
      text: "第2条",
    });
    expect(typeof lb.messages[0].created_at).toBe("string"); // ISO 8601
    const gap = await app.request(`/api/messages?since=${a.id}`);
    const gb = await gap.json();
    expect(gb.messages.map((m: any) => m.id)).toEqual([b.id]);
  });

  test("错误信封：400 禁词 / 400 uuid / 429 限流（含 retry_after_ms）", async () => {
    const { app } = await boot({
      rate: {
        msgPerMin: 2,
        streamPerMin: 20,
        loginPerMin: 5,
        windowMs: 60_000,
      },
    });
    const send = (text: string) =>
      app.request("/api/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "5.6.7.8",
        },
        body: JSON.stringify({ client_id: UUID, nick: "甲", text }),
      });
    let res = await send("阳光大赌博场");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("banned_word");
    res = await send("正常消息");
    expect(res.status).toBe(201);
    res = await send("第二条");
    expect(res.status).toBe(201);
    res = await send("第三条超限");
    expect(res.status).toBe(429);
    const err = await res.json();
    expect(err.error.code).toBe("rate_limited");
    expect(err.error.retry_after_ms).toBeGreaterThan(0);
    const bad = await app.request("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "bad", nick: "甲", text: "x" }),
    });
    expect((await bad.json()).error.code).toBe("invalid_uuid");
  });

  test("词库：basic 模式从磁盘加载精选词表，错误响应不回显命中词", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wl-words-"));
    mkdirSync(join(dir, "basic"));
    writeFileSync(
      join(dir, "basic", "porn.txt"),
      "# 精选表（含注释行）\n测试违禁词A\n",
    );
    const { app } = await boot({
      bannedWordsMode: "basic",
      bannedWordsDir: dir,
      bannedWords: [],
    });
    const send = (text: string) =>
      app.request("/api/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "3.3.3.3",
        },
        body: JSON.stringify({ client_id: UUID, nick: "甲", text }),
      });
    // the space-split variant must be caught by normalization
    const res = await send("这里出现测试违禁词A了呢");
    expect(res.status).toBe(400);
    const raw = await res.text();
    expect(JSON.parse(raw).error.code).toBe("banned_word");
    expect(raw).not.toContain("测试违禁词A"); // the matched word must not be echoed
    expect((await send("测试违禁词 A")).status).toBe(400);
    expect((await send("正常内容")).status).toBe(201);
    rmSync(dir, { recursive: true, force: true });
  });

  test("禁言：命中 bans 的 IP POST → 403 banned（含 reason）；未被禁 IP 正常", async () => {
    const { app, repo } = await boot();
    await repo.banUpsert("8.8.8.8", "spam", "admin", Date.now());
    const res = await app.request("/api/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "8.8.8.8",
      },
      body: JSON.stringify({ client_id: UUID, nick: "甲", text: "hi" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatchObject({
      code: "banned",
      reason: "spam",
    });
  });

  test("backfill 深度：HISTORY_MAX_BACKFILL>0 时 beyond 返回空并带 mode", async () => {
    const { app } = await boot({ backfillMax: 2 });
    for (let i = 0; i < 3; i++) {
      await app.request("/api/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "3.3.3.3",
        },
        body: JSON.stringify({ client_id: UUID, nick: "n", text: `m${i}` }),
      });
    }
    const res = await app.request("/api/messages?limit=50");
    const body = await res.json();
    expect(body.messages.length).toBe(2); // newest first, capped at 2
    expect(body.mode).toBeDefined();
  });

  test("Origin 白名单 fail-closed + 开放模式回 ACAO *", async () => {
    const open = await boot();
    const r1 = await open.app.request("/api/meta", {
      headers: { origin: "https://any.com" },
    });
    expect(r1.headers.get("access-control-allow-origin")).toBe("*");
    const locked = await boot({ allowedOrigins: ["https://a.com"] });
    const ok = await locked.app.request("/api/meta", {
      headers: { origin: "https://a.com" },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://a.com");
    const bad = await locked.app.request("/api/meta", {
      headers: { origin: "https://evil.com" },
    });
    expect(bad.status).toBe(403);
    expect((await bad.json()).error.code).toBe("origin_not_allowed");
    const none = await locked.app.request("/api/meta");
    expect(none.status).toBe(200);
  });

  test("Origin 闸口可诊断：403 回显收到的 Origin、/api/meta 报 open|locked", async () => {
    const locked = await boot({ allowedOrigins: ["https://a.com"] });
    const bad = await locked.app.request("/api/meta", {
      headers: { origin: "https://EVIL.com/" },
    });
    expect(bad.status).toBe(403);
    const body = await bad.json();
    expect(body.error.code).toBe("origin_not_allowed");
    // echoes the normalized origin so a rejection can be traced
    expect(body.error.origin).toBe("https://evil.com");
    expect(body.error.allowed_origins_count).toBe(1);

    const lockedMeta = await (await locked.app.request("/api/meta")).json();
    expect(lockedMeta.origin_mode).toBe("locked");
    const openMeta = await (
      await (await boot()).app.request("/api/meta")
    ).json();
    expect(openMeta.origin_mode).toBe("open");
  });

  test("Origin 通配符子域：同域任意子域放行并回显 ACAO", async () => {
    const locked = await boot({ allowedOrigins: ["*.damon233.top"] });
    const ok = await locked.app.request("/api/meta", {
      headers: { origin: "https://livechat.damon233.top" },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(
      "https://livechat.damon233.top",
    );
    expect((await ok.json()).origin_mode).toBe("locked");
    const apex = await locked.app.request("/api/meta", {
      headers: { origin: "https://damon233.top" },
    });
    expect(apex.status).toBe(200);
    const other = await locked.app.request("/api/meta", {
      headers: { origin: "https://evil-damon233.top" },
    });
    expect(other.status).toBe(403);
    expect((await other.json()).error.code).toBe("origin_not_allowed");
  });

  test("维护触发：接近 maxRows 广播 notice；到顶 → ephemeral 停写历史", async () => {
    const { app, repo } = await boot({ maxRows: 4, maintenanceEvery: 1 });
    const send = () =>
      app.request("/api/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "4.4.4.4",
        },
        body: JSON.stringify({ client_id: UUID, nick: "n", text: "x" }),
      });
    for (let i = 0; i < 4; i++) {
      const r = await send();
      expect(r.status).toBe(201);
    }
    const r5 = await send(); // 5th write hits the row cap: events only
    expect(r5.status).toBe(201);
    const hist = await (await app.request("/api/messages?limit=10")).json();
    expect(hist).toMatchObject({ messages: [], mode: "ephemeral" });
    const stats = await repo.messageStats();
    expect(stats.total).toBe(4);
    const evs = await repo.eventsSince(0, 100);
    expect(evs.some((e) => e.type === "notice")).toBe(true); // history_mode notice
    const msgEvs = evs.filter((e) => e.type === "message");
    expect(
      JSON.parse(msgEvs[msgEvs.length - 1].payload).id.startsWith("e"),
    ).toBe(true);
  });

  test("DB 故障：GET /api/messages → 503 db_unavailable 信封（非 500）", async () => {
    const { app, repo } = await boot();
    const orig = repo.historyBefore.bind(repo);
    repo.historyBefore = async () => {
      throw new Error("conn refused");
    };
    const res = await app.request("/api/messages?limit=5", {
      headers: { "x-forwarded-for": "9.9.9.9" },
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("db_unavailable");
    repo.historyBefore = orig;
  });

  test("bootstrap 失败 → 503 且不缓存：恢复后同实例下一请求自愈", async () => {
    const { app, repo } = await boot();
    const orig = repo.bootstrap.bind(repo);
    repo.bootstrap = async () => {
      throw new Error("ddl failed");
    };
    const res1 = await app.request("/api/meta", {
      headers: { "x-forwarded-for": "9.9.9.9" },
    });
    expect(res1.status).toBe(503);
    expect((await res1.json()).error.code).toBe("db_unavailable");
    repo.bootstrap = orig;
    const res2 = await app.request("/api/meta", {
      headers: { "x-forwarded-for": "9.9.9.9" },
    });
    expect(res2.status).toBe(200);
  });
});

describe("SSE 事件流", () => {
  test("开流收 presence 初值；POST 后经 events 广播收到 message", async () => {
    const { app } = await boot();
    const ctrl = new AbortController();
    const res = await app.request(`/api/stream?client_id=${UUID}`, {
      headers: { "x-forwarded-for": "1.1.1.1" },
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // second connection reuses client_id: presence dedupes per client
    const res2 = await app.request(`/api/stream?client_id=${UUID}`, {
      headers: { "x-forwarded-for": "2.2.2.2" },
    });
    const post = await app.request("/api/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "1.1.1.1",
      },
      body: JSON.stringify({ client_id: UUID, nick: "甲", text: "流广播" }),
    });
    expect(post.status).toBe(201);
    // readSse stops at the match; the presence frame arrives first and is buffered too
    const seen = await readSse(
      res,
      (type, data) => type === "message" && data.text === "流广播",
      3000,
    );
    expect(seen.some((e) => e.type === "presence")).toBe(true);
    expect(seen.some((e) => e.type === "message")).toBe(true);
    await res2.body?.cancel().catch(() => {});
    ctrl.abort();
  });

  test("开流限流：streamPerMin=1 时同 IP 第二条 429（stream 桶接线）", async () => {
    const { app } = await boot({
      rate: {
        msgPerMin: 10,
        streamPerMin: 1,
        loginPerMin: 5,
        windowMs: 60_000,
      },
    });
    const ctrl = new AbortController();
    const first = await app.request(`/api/stream?client_id=${UUID}`, {
      headers: { "x-forwarded-for": "6.6.6.6" },
      signal: ctrl.signal,
    });
    expect(first.status).toBe(200);
    const second = await app.request(`/api/stream?client_id=${UUID}`, {
      headers: { "x-forwarded-for": "6.6.6.6" },
    });
    expect(second.status).toBe(429); // same aligned window, so no real 60s wait
    const err = await second.json();
    expect(err.error.code).toBe("rate_limited");
    expect(err.error.retry_after_ms).toBeGreaterThan(0);
    await first.body?.cancel().catch(() => {});
    ctrl.abort();
  });

  test("禁言 IP 开流：首帧 event: ban（禁言不禁看，流保持）", async () => {
    const { app, repo } = await boot();
    await repo.banUpsert("7.7.7.7", "spam", "admin", Date.now());
    const res = await app.request(`/api/stream?client_id=${UUID}`, {
      headers: { "x-forwarded-for": "7.7.7.7" },
    });
    expect(res.status).toBe(200);
    const seen = await readSse(res, (type) => type === "ban", 2000);
    const ban = seen.find((e) => e.type === "ban");
    expect(ban).toBeDefined();
    expect(ban?.data.reason).toBe("spam");
  });
});
