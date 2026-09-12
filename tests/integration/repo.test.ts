import { describe, expect, test } from "bun:test";
import { makeRepo, type TestProvider } from "../helpers";

/** Same contract suite per provider (sqlite + memory locally; DB_PROVIDER=postgres runs PG). */
function contract(provider: TestProvider) {
  describe(`Repo 契约 · ${provider}`, () => {
    // Cross-dialect sentinel: PG serial is int4, and postgres.js sends numbers as text,
    // so MAX_SAFE_INTEGER fails at runtime instead of being clamped.
    const PG_SAFE_MAX_ID = 2_147_483_647;

    test("bootstrap 幂等：可重复调用", async () => {
      const { repo, cleanup } = await makeRepo(provider);
      await repo.bootstrap();
      await repo.bootstrap();
      await cleanup();
    });

    test("sendMessageAndEvent 事务双写：返回两个自增 id，messages 与 events 各一行", async () => {
      const { repo, cleanup } = await makeRepo(provider);
      const now = Date.now();
      const { messageId, eventId } = await repo.sendMessageAndEvent({
        client_id: "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1",
        nick: "甲",
        text: "你好",
        created_at: now,
      });
      expect(messageId).toBeGreaterThan(0);
      expect(eventId).toBeGreaterThan(0);
      const hist = await repo.historyBefore(PG_SAFE_MAX_ID, 10);
      expect(hist).toHaveLength(1);
      expect(hist[0].nick).toBe("甲");
      const evs = await repo.eventsSince(0, 10);
      expect(evs).toHaveLength(1);
      expect(evs[0].type).toBe("message");
      // payload is built inside the transaction: message id + full snapshot
      const pl = JSON.parse(evs[0].payload);
      expect(pl.id).toBe(String(messageId));
      expect(pl.text).toBe("你好");
      await cleanup();
    });

    test("historyBefore 新→旧 / historySince 旧→新 / 软删映射 text=null", async () => {
      const { repo, cleanup } = await makeRepo(provider);
      const now = Date.now();
      const sent: { messageId: number }[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await repo.sendMessageAndEvent({
          client_id: "c",
          nick: "n",
          text: `m${i}`,
          created_at: now + i,
        });
        sent.push(r);
      }
      const before = await repo.historyBefore(sent[2].messageId, 10);
      expect(before.map((m) => m.text)).toEqual(["m1", "m0"]); // older than id2, descending
      const since = await repo.historySince(sent[0].messageId, 10);
      expect(since.map((m) => m.text)).toEqual(["m1", "m2"]);
      const ok = await repo.softDeleteMessage(
        sent[1].messageId,
        "admin",
        now + 100,
      );
      expect(ok).toBe(true);
      // second soft delete matches no row (deleted_at already set)
      const okAgain = await repo.softDeleteMessage(
        sent[1].messageId,
        "admin",
        now + 200,
      );
      expect(okAgain).toBe(false);
      const all = await repo.historyBefore(PG_SAFE_MAX_ID, 10);
      expect(all.find((m) => m.id === sent[1].messageId)).toMatchObject({
        text: null,
        deleted: true,
      });
      await cleanup();
    });

    test("封禁：upsert 幂等、get/list/remove", async () => {
      const { repo, cleanup } = await makeRepo(provider);
      expect(await repo.banUpsert("1.2.3.4", "spam", "admin", Date.now())).toBe(
        true,
      );
      expect(
        await repo.banUpsert("1.2.3.4", "spam2", "admin", Date.now()),
      ).toBe(false);
      expect((await repo.banGet("1.2.3.4"))?.reason).toBe("spam2");
      expect(await repo.banList(100, 0)).toHaveLength(1);
      expect(await repo.banRemove("1.2.3.4")).toBe(true);
      expect(await repo.banGet("1.2.3.4")).toBeNull();
      await cleanup();
    });

    test("presence upsert 覆盖 + count 按 TTL 过滤", async () => {
      const { repo, cleanup } = await makeRepo(provider);
      await repo.presenceUpsert("a", 1000);
      await repo.presenceUpsert("a", 2000);
      await repo.presenceUpsert("b", 9000);
      expect(await repo.presenceCount(5000)).toBe(1); // a is stale
      expect(await repo.presenceCount(0)).toBe(2);
      await cleanup();
    });

    test("rateHit 原子自增到超限；独立 scope 互不影响", async () => {
      const { repo, cleanup } = await makeRepo(provider);
      for (let i = 1; i <= 3; i++)
        expect(await repo.rateHit("msg", "9.9.9.9", 0)).toBe(i);
      expect(await repo.rateHit("msg", "8.8.8.8", 0)).toBe(1);
      expect(await repo.rateHit("stream", "9.9.9.9", 0)).toBe(1); // separate buckets
      await cleanup();
    });

    test("publishEphemeralMessage 只写 events：payload id=e<id>，messages 不增", async () => {
      const { repo, cleanup } = await makeRepo(provider);
      const statsBefore = await repo.messageStats();
      const now = Date.now();
      const { eventId } = await repo.publishEphemeralMessage({
        client_id: "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1",
        nick: "乙",
        text: "live-only",
        created_at: now,
      });
      expect(eventId).toBeGreaterThan(0);
      const evs = await repo.eventsSince(0, 10);
      expect(evs).toHaveLength(1);
      expect(evs[0].type).toBe("message");
      expect(evs[0].created_at).toBe(now); // both drivers normalize created_at to a number
      const pl = JSON.parse(evs[0].payload);
      expect(pl.id).toBe(`e${eventId}`); // e-prefix keeps out of the messages.id namespace
      expect(pl.text).toBe("live-only");
      expect((await repo.messageStats()).total).toBe(statsBefore.total);
      await cleanup();
    });

    test("清洗与统计：events/presence/rate_limits 过期删除、消息超行数裁剪、day 裁剪", async () => {
      const { repo, cleanup } = await makeRepo(provider);
      await repo.insertEvent("notice", "{}", 1000);
      expect(await repo.cleanupEvents(2000)).toBe(1);
      await repo.presenceUpsert("gone", 1000);
      expect(await repo.cleanupPresence(5000)).toBe(1);
      await repo.rateHit("msg", "9.9.9.9", 0);
      expect(await repo.cleanupRateLimits(100)).toBe(1);
      // row-cap trim: everything at/above the floor id survives
      for (let i = 0; i < 5; i++)
        await repo.sendMessageAndEvent({
          client_id: "c",
          nick: "n",
          text: `t${i}`,
          created_at: 1,
        });
      const stats = await repo.messageStats();
      expect(stats.total).toBe(5);
      const keep = (await repo.historyBefore(PG_SAFE_MAX_ID, 10))[2].id; // 3rd newest id
      await repo.trimMessagesBelow(keep);
      expect((await repo.messageStats()).total).toBe(3);
      await repo.deleteMessagesOlderThan(50); // created_at=1 < 50, so all rows go
      expect((await repo.messageStats()).total).toBe(0);
      await cleanup();
    });
    test("危险操作：purgeCounts 行数；clearData(chat) 保留封禁/在线/限流，full 全清", async () => {
      const { repo, cleanup } = await makeRepo(provider);
      const now = Date.now();
      const seed = async () => {
        for (let i = 0; i < 2; i++)
          await repo.sendMessageAndEvent({
            client_id: "c",
            nick: "n",
            text: `m${i}`,
            created_at: now + i,
          });
        await repo.presenceUpsert("p", now);
        await repo.banUpsert("1.2.3.4", "spam", "admin", now);
        await repo.rateHit("msg", "9.9.9.9", 0);
      };
      await seed();
      expect(await repo.purgeCounts()).toEqual({
        messages: 2,
        events: 2,
        presence: 1,
        rate_limits: 1,
        bans: 1,
      });

      // chat scope must never touch the ban list
      expect(await repo.clearData("chat")).toEqual({
        messages: 2,
        events: 2,
        presence: 0,
        rate_limits: 0,
        bans: 0,
      });
      expect(await repo.purgeCounts()).toEqual({
        messages: 0,
        events: 0,
        presence: 1,
        rate_limits: 1,
        bans: 1,
      });
      // read paths empty, including the events cursor baseline
      expect(await repo.historyBefore(PG_SAFE_MAX_ID, 10)).toEqual([]);
      expect(await repo.eventsSince(0, 10)).toEqual([]);
      expect(await repo.eventsMaxId()).toBe(0);

      // full scope wipes all five tables (counts are physical rows)
      await seed();
      expect(await repo.clearData("full")).toEqual({
        messages: 2,
        events: 2,
        presence: 1,
        rate_limits: 1,
        bans: 1,
      });
      expect(await repo.purgeCounts()).toEqual({
        messages: 0,
        events: 0,
        presence: 0,
        rate_limits: 0,
        bans: 0,
      });
      expect(await repo.messageStats()).toEqual({ total: 0, retained: 0 });
      expect(await repo.banGet("1.2.3.4")).toBeNull();
      // clearing an empty DB is not an error
      expect(await repo.clearData("full")).toEqual({
        messages: 0,
        events: 0,
        presence: 0,
        rate_limits: 0,
        bans: 0,
      });
      await cleanup();
    });
  });
}

const explicit = process.env.DB_PROVIDER;
if (explicit && ["sqlite", "postgres", "memory"].includes(explicit)) {
  contract(explicit as TestProvider);
} else {
  // default: both sqlite and memory run locally
  contract("sqlite");
  contract("memory");
}
