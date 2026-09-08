import { describe, expect, test } from "bun:test";
import { makeRepo } from "../helpers";

describe("Repo 双库契约", () => {
  // 跨方言安全上界哨兵：PG serial(int4) 不可能超过 int4 上限，sqlite AUTOINCREMENT 实际行数远达不到。
  // 不能用 Number.MAX_SAFE_INTEGER —— postgres.js 以 oid 0 文本发送数字，PG 按列类型 int4 解析 → 执行期 out of range。
  const PG_SAFE_MAX_ID = 2_147_483_647;

  test("bootstrap 幂等：可重复调用", async () => {
    const { repo, cleanup } = await makeRepo();
    await repo.bootstrap();
    await repo.bootstrap();
    await cleanup();
  });

  test("sendMessageAndEvent 事务双写：返回两个自增 id，messages 与 events 各一行", async () => {
    const { repo, cleanup } = await makeRepo();
    const now = Date.now();
    const { messageId, eventId } = await repo.sendMessageAndEvent(
      { client_id: "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1", nick: "甲", text: "你好", created_at: now },
    );
    expect(messageId).toBeGreaterThan(0);
    expect(eventId).toBeGreaterThan(0);
    const hist = await repo.historyBefore(PG_SAFE_MAX_ID, 10);
    expect(hist).toHaveLength(1);
    expect(hist[0].nick).toBe("甲");
    const evs = await repo.eventsSince(0, 10);
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe("message");
    // payload 由事务方法内部构造：含消息 id 与全文（客户端去重依据）
    const pl = JSON.parse(evs[0].payload);
    expect(pl.id).toBe(String(messageId));
    expect(pl.text).toBe("你好");
    await cleanup();
  });

  test("historyBefore 新→旧 / historySince 旧→新 / 软删映射 text=null", async () => {
    const { repo, cleanup } = await makeRepo();
    const now = Date.now();
    const sent: { messageId: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await repo.sendMessageAndEvent(
        { client_id: "c", nick: "n", text: `m${i}`, created_at: now + i },
      );
      sent.push(r);
    }
    const before = await repo.historyBefore(sent[2].messageId, 10);
    expect(before.map(m => m.text)).toEqual(["m1", "m0"]); // < id2，降序
    const since = await repo.historySince(sent[0].messageId, 10);
    expect(since.map(m => m.text)).toEqual(["m1", "m2"]);
    const ok = await repo.softDeleteMessage(sent[1].messageId, "admin", now + 100);
    expect(ok).toBe(true);
    // 幂等：同一行二次软删命中 WHERE deleted_at IS NULL 失败 → 返回 false
    const okAgain = await repo.softDeleteMessage(sent[1].messageId, "admin", now + 200);
    expect(okAgain).toBe(false);
    const all = await repo.historyBefore(PG_SAFE_MAX_ID, 10);
    expect(all.find(m => m.id === sent[1].messageId)).toMatchObject({ text: null, deleted: true });
    await cleanup();
  });

  test("封禁：upsert 幂等、get/list/remove", async () => {
    const { repo, cleanup } = await makeRepo();
    expect(await repo.banUpsert("1.2.3.4", "spam", "admin", Date.now())).toBe(true);
    expect(await repo.banUpsert("1.2.3.4", "spam2", "admin", Date.now())).toBe(false); // 已存在
    expect((await repo.banGet("1.2.3.4"))?.reason).toBe("spam2");
    expect(await repo.banList(100, 0)).toHaveLength(1);
    expect(await repo.banRemove("1.2.3.4")).toBe(true);
    expect(await repo.banGet("1.2.3.4")).toBeNull();
    await cleanup();
  });

  test("presence upsert 覆盖 + count 按 TTL 过滤", async () => {
    const { repo, cleanup } = await makeRepo();
    await repo.presenceUpsert("a", 1000);
    await repo.presenceUpsert("a", 2000); // 覆盖
    await repo.presenceUpsert("b", 9000);
    expect(await repo.presenceCount(5000)).toBe(1); // a 过期
    expect(await repo.presenceCount(0)).toBe(2);
    await cleanup();
  });

  test("rateHit 原子自增到超限；独立 scope 互不影响", async () => {
    const { repo, cleanup } = await makeRepo();
    for (let i = 1; i <= 3; i++) expect(await repo.rateHit("msg", "9.9.9.9", 0)).toBe(i);
    expect(await repo.rateHit("msg", "8.8.8.8", 0)).toBe(1);
    expect(await repo.rateHit("stream", "9.9.9.9", 0)).toBe(1); // 不同桶独立
    await cleanup();
  });

  test("publishEphemeralMessage 只写 events：payload id=e<id>，messages 不增", async () => {
    const { repo, cleanup } = await makeRepo();
    const statsBefore = await repo.messageStats();
    const now = Date.now();
    const { eventId } = await repo.publishEphemeralMessage(
      { client_id: "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1", nick: "乙", text: "live-only", created_at: now },
    );
    expect(eventId).toBeGreaterThan(0);
    const evs = await repo.eventsSince(0, 10);
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe("message");
    expect(evs[0].created_at).toBe(now); // created_at 双驱动归一为 number
    const pl = JSON.parse(evs[0].payload);
    expect(pl.id).toBe(`e${eventId}`); // e 前缀避开 messages.id 命名空间
    expect(pl.text).toBe("live-only");
    expect((await repo.messageStats()).total).toBe(statsBefore.total); // 不落 messages
    await cleanup();
  });

  test("清洗与统计：events/presence/rate_limits 过期删除、消息超行数裁剪、day 裁剪", async () => {
    const { repo, cleanup } = await makeRepo();
    await repo.insertEvent("notice", "{}", 1000);
    expect(await repo.cleanupEvents(2000)).toBe(1);
    await repo.presenceUpsert("gone", 1000);
    expect(await repo.cleanupPresence(5000)).toBe(1);
    await repo.rateHit("msg", "9.9.9.9", 0);
    expect(await repo.cleanupRateLimits(100)).toBe(1);
    // 消息行数裁剪：造 5 行，floor 后仅留 ≥ floor
    for (let i = 0; i < 5; i++) await repo.sendMessageAndEvent({ client_id: "c", nick: "n", text: `t${i}`, created_at: 1 });
    const stats = await repo.messageStats();
    expect(stats.total).toBe(5);
    const keep = (await repo.historyBefore(PG_SAFE_MAX_ID, 10))[2].id; // 保留最新的 3 条 → floor 为第 3 新
    await repo.trimMessagesBelow(keep);
    expect((await repo.messageStats()).total).toBe(3);
    await repo.deleteMessagesOlderThan(50); // created_at=1 < 50 → 全删
    expect((await repo.messageStats()).total).toBe(0);
    await cleanup();
  });
});
