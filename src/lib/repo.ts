import { createClient, type Client } from "@libsql/client";
import postgres from "postgres";
import type { Provider } from "./config";
import { ddlFor } from "./ddl";
import {
  PURGE_ALL_TABLES,
  PURGE_TABLES,
  type PurgeCounts,
  type PurgeScope,
  type PurgeTable,
} from "./purge";

export interface MessageRow {
  id: number;
  client_id: string;
  nick: string;
  text: string | null;
  created_at: number;
  deleted: boolean;
  deleted_at: number | null;
}
export interface EventRow {
  id: number;
  type: string;
  payload: string;
  created_at: number;
}

export interface MessageInput {
  client_id: string;
  nick: string;
  text: string;
  created_at: number;
}
export interface BanRow {
  ip: string;
  reason: string;
  created_at: number;
}

export interface Repo {
  readonly provider: Provider;
  bootstrap(): Promise<void>;
  close(): Promise<void>;
  /** events + messages 单事务双写（SQLite BEGIN IMMEDIATE / PG begin）。
   * 事件类型恒为 message；payload 由实现**在事务内拿到 messageId 后自动构造**：
   * `{id: String(messageId), client_id, nick, text, created_at}`（含 id 供客户端去重/对应 delete）。 */
  sendMessageAndEvent(
    m: MessageInput,
  ): Promise<{ messageId: number; eventId: number }>;
  /** 仅实时（ephemeral 模式）广播：只写 events、不写 messages；payload id 形如 "e<eventId>"（避开 messages.id 命名空间，避免 delete 误伤）。
   * 内部先插空 payload 取 eventId，再在**同一事务**内 UPDATE 为完整 JSON。 */
  publishEphemeralMessage(m: MessageInput): Promise<{ eventId: number }>;
  insertEvent(
    type: string,
    payload: string,
    created_at: number,
  ): Promise<number>;
  eventsSince(since: number, limit: number): Promise<EventRow[]>;
  eventsMaxId(): Promise<number>;
  historyBefore(before: number, limit: number): Promise<MessageRow[]>;
  historySince(since: number, limit: number): Promise<MessageRow[]>;
  softDeleteMessage(id: number, by: string, at: number): Promise<boolean>;
  banUpsert(
    ip: string,
    reason: string,
    by: string,
    at: number,
  ): Promise<boolean>;
  banGet(ip: string): Promise<{ reason: string; created_at: number } | null>;
  banList(limit: number, offset: number): Promise<BanRow[]>;
  banRemove(ip: string): Promise<boolean>;
  presenceUpsert(clientId: string, at: number): Promise<void>;
  presenceCount(cutoff: number): Promise<number>;
  rateHit(bucket: string, scope: string, windowStart: number): Promise<number>;
  /** 消息行统计：total 与 retained 同为**物理行数**（含软删占位行；软删不删行，仅保留裁剪/超龄清理才物理删除）。容量判定/降级/estimate_bytes 一律用此口径。 */
  messageStats(): Promise<{ total: number; retained: number }>;
  cleanupEvents(before: number): Promise<number>;
  cleanupPresence(before: number): Promise<number>;
  cleanupRateLimits(before: number): Promise<number>;
  trimMessagesBelow(idFloor: number): Promise<number>;
  deleteMessagesOlderThan(cutoff: number): Promise<number>;
  /** 危险操作·预检：各表当前物理行数（只读，不修改任何数据）。 */
  purgeCounts(): Promise<PurgeCounts>;
  /** 危险操作·执行：按档位白名单清空数据，返回各表**实际删除行数**（未涉及的表恒为 0）。
   * 档位 → 表 的映射由 PURGE_TABLES 唯一决定，调用方无法指定任意表名。 */
  clearData(scope: PurgeScope): Promise<PurgeCounts>;
}

const mapMessage = (r: any): MessageRow => ({
  id: Number(r.id),
  client_id: r.client_id,
  nick: r.nick,
  text: r.deleted_at === null || r.deleted_at === undefined ? r.text : null,
  created_at: Number(r.created_at),
  deleted: !(r.deleted_at === null || r.deleted_at === undefined),
  deleted_at:
    r.deleted_at === null || r.deleted_at === undefined
      ? null
      : Number(r.deleted_at),
});

/** events 行归一：PG bigint 列返回 string，sqlite INTEGER 返回 number → 两驱动统一收口为 number（与 mapMessage 同策略）。 */
const mapEvent = (r: any): EventRow => ({
  id: Number(r.id),
  type: r.type,
  payload: r.payload,
  created_at: Number(r.created_at),
});

// SQL 模板（仅含 ? 占位；按方言追加 RETURNING 或用事务包裹，见各自的执行分支）
const SQL = {
  insMessage:
    "INSERT INTO messages (client_id, nick, text, created_at) VALUES (?, ?, ?, ?)",
  insEvent: "INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)",
  updEventPayload: "UPDATE events SET payload = ? WHERE id = ?",
  eventsSince: "SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?",
  maxEventId: "SELECT COALESCE(MAX(id), 0) AS m FROM events",
  before: "SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?",
  since: "SELECT * FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?",
  softDel:
    "UPDATE messages SET deleted_at = ?, deleted_by = ?, text = '' WHERE id = ? AND deleted_at IS NULL",
  banInsert:
    "INSERT INTO bans (ip, reason, banned_by, created_at) VALUES (?, ?, ?, ?)",
  banUpdate:
    "UPDATE bans SET reason = ?, banned_by = ?, created_at = ? WHERE ip = ?",
  banGet: "SELECT reason, created_at FROM bans WHERE ip = ?",
  banList:
    "SELECT ip, reason, created_at FROM bans ORDER BY created_at DESC LIMIT ? OFFSET ?",
  banDel: "DELETE FROM bans WHERE ip = ?",
  presUp:
    "INSERT INTO presence (client_id, last_seen) VALUES (?, ?) ON CONFLICT (client_id) DO UPDATE SET last_seen = excluded.last_seen",
  presCnt: "SELECT COUNT(*) AS c FROM presence WHERE last_seen > ?",
  rateHit: `INSERT INTO rate_limits (bucket, scope, window_start, count) VALUES (?, ?, ?, 1)
            ON CONFLICT (bucket, scope, window_start) DO UPDATE SET count = count + 1 RETURNING count`,
  stats: "SELECT COUNT(*) AS total FROM messages",
  delEvents: "DELETE FROM events WHERE created_at < ?",
  delPres: "DELETE FROM presence WHERE last_seen < ?",
  delRates: "DELETE FROM rate_limits WHERE window_start < ?",
  trimBelow: "DELETE FROM messages WHERE id < ?",
  delOlder: "DELETE FROM messages WHERE created_at < ?",
  // 危险操作（清空）：计数与全表删除分开命名，避免与上面带 WHERE 的清理语句混用
  cntMessages: "SELECT COUNT(*) AS c FROM messages",
  cntEvents: "SELECT COUNT(*) AS c FROM events",
  cntPresence: "SELECT COUNT(*) AS c FROM presence",
  cntBans: "SELECT COUNT(*) AS c FROM bans",
  cntRateLimits: "SELECT COUNT(*) AS c FROM rate_limits",
};

/** 档位白名单 → 全表删除语句（三驱动共用同一套 ? 占位模板）。 */
const DELETE_ALL_SQL: Record<PurgeTable, string> = {
  messages: "DELETE FROM messages",
  events: "DELETE FROM events",
  presence: "DELETE FROM presence",
  rate_limits: "DELETE FROM rate_limits",
  bans: "DELETE FROM bans",
};

const COUNT_SQL: Record<PurgeTable, string> = {
  messages: SQL.cntMessages,
  events: SQL.cntEvents,
  presence: SQL.cntPresence,
  rate_limits: SQL.cntRateLimits,
  bans: SQL.cntBans,
};

/** 固定遍历顺序（仅影响响应里的字段顺序，与语义无关）。 */
const emptyCounts = (): PurgeCounts => ({
  messages: 0,
  events: 0,
  presence: 0,
  rate_limits: 0,
  bans: 0,
});

/** PG 专用：借助 xmax=0（本语句新插入）区分「新增」与「冲突后更新」，实现 true=新建/false=已存在。 */
const banUpsertPg = `INSERT INTO bans (ip, reason, banned_by, created_at) VALUES (?, ?, ?, ?)
  ON CONFLICT (ip) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by, created_at = excluded.created_at
  RETURNING (xmax = 0) AS inserted`;

const BAN_EXISTS = "SELECT 1 AS x FROM bans WHERE ip = ?";

class SqliteRepo implements Repo {
  readonly provider = "sqlite" as const;
  constructor(private c: Client) {}
  async bootstrap(): Promise<void> {
    for (const d of ddlFor("sqlite")) await this.c.execute(d);
  }
  async close(): Promise<void> {
    this.c.close();
  }
  private async run<T>(sql: string, args: unknown[]): Promise<T> {
    const r = await this.c.execute({ sql, args: args as any[] });
    // SAFETY: libsql 返回的 Row 列已是 JS 原始类型（number/string/null）且与各查询契约行一一对应；
    // 调用点按查询用行类型（any[] + map/Number 归一）收口，T 仅为免重复声明的泛型，非运行时强制。
    return r.rows as unknown as T;
  }
  private async exec(sql: string, args: unknown[] = []): Promise<void> {
    await this.c.execute({ sql, args: args as any[] });
  }

  async sendMessageAndEvent(
    m: MessageInput,
  ): Promise<{ messageId: number; eventId: number }> {
    const tx = await this.c.transaction("write"); // @libsql/client：BEGIN IMMEDIATE（execute 逐条自动提交，须用事务对象）
    try {
      const ins = await tx.execute({
        sql: SQL.insMessage,
        args: [m.client_id, m.nick, m.text, m.created_at],
      });
      const messageId = Number(ins.lastInsertRowid);
      const payload = JSON.stringify({
        id: String(messageId),
        client_id: m.client_id,
        nick: m.nick,
        text: m.text,
        created_at: m.created_at,
      });
      const ev = await tx.execute({
        sql: SQL.insEvent,
        args: ["message", payload, m.created_at],
      });
      const eventId = Number(ev.lastInsertRowid);
      await tx.commit();
      return { messageId, eventId };
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
  }

  async publishEphemeralMessage(m: MessageInput): Promise<{ eventId: number }> {
    const tx = await this.c.transaction("write");
    try {
      const ev = await tx.execute({
        sql: SQL.insEvent,
        args: ["message", "", m.created_at],
      });
      const eventId = Number(ev.lastInsertRowid);
      const payload = JSON.stringify({
        id: `e${eventId}`,
        client_id: m.client_id,
        nick: m.nick,
        text: m.text,
        created_at: m.created_at,
      });
      await tx.execute({ sql: SQL.updEventPayload, args: [payload, eventId] });
      await tx.commit();
      return { eventId };
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
  }
  async insertEvent(
    type: string,
    payload: string,
    created_at: number,
  ): Promise<number> {
    const r = await this.c.execute({
      sql: SQL.insEvent,
      args: [type, payload, created_at],
    });
    return Number(r.lastInsertRowid);
  }
  async eventsSince(since: number, limit: number): Promise<EventRow[]> {
    return (await this.run<any[]>(SQL.eventsSince, [since, limit])).map(
      mapEvent,
    );
  }
  async eventsMaxId(): Promise<number> {
    const r = await this.run<any[]>(SQL.maxEventId, []);
    return Number(r[0]?.m ?? 0);
  }
  async historyBefore(before: number, limit: number): Promise<MessageRow[]> {
    return (await this.run<any[]>(SQL.before, [before, limit])).map(mapMessage);
  }
  async historySince(since: number, limit: number): Promise<MessageRow[]> {
    return (await this.run<any[]>(SQL.since, [since, limit])).map(mapMessage);
  }
  async softDeleteMessage(
    id: number,
    by: string,
    at: number,
  ): Promise<boolean> {
    const r = await this.c.execute({ sql: SQL.softDel, args: [at, by, id] });
    return Number(r.rowsAffected) > 0;
  }
  /** true = 新建封禁；false = 该 IP 已在封禁名单（本次覆盖更新）。libsql/sqlite 的 UPSERT rowsAffected 恒为 1（实证），
   * 无法区分分支 → 写事务（BEGIN IMMEDIATE）内存在性检查判定，原子。 */
  async banUpsert(
    ip: string,
    reason: string,
    by: string,
    at: number,
  ): Promise<boolean> {
    const tx = await this.c.transaction("write");
    try {
      const existing = await tx.execute({ sql: BAN_EXISTS, args: [ip] });
      const isNew = existing.rows.length === 0;
      if (isNew) {
        await tx.execute({ sql: SQL.banInsert, args: [ip, reason, by, at] });
      } else {
        await tx.execute({ sql: SQL.banUpdate, args: [reason, by, at, ip] });
      }
      await tx.commit();
      return isNew;
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
  }
  async banGet(
    ip: string,
  ): Promise<{ reason: string; created_at: number } | null> {
    const r = await this.run<any[]>(SQL.banGet, [ip]);
    return r[0]
      ? { reason: r[0].reason, created_at: Number(r[0].created_at) }
      : null;
  }
  async banList(limit: number, offset: number): Promise<BanRow[]> {
    return this.run<any[]>(SQL.banList, [limit, offset]).then((rs) =>
      rs.map((r) => ({
        ip: r.ip,
        reason: r.reason,
        created_at: Number(r.created_at),
      })),
    );
  }
  async banRemove(ip: string): Promise<boolean> {
    const r = await this.c.execute({ sql: SQL.banDel, args: [ip] });
    return Number(r.rowsAffected) > 0;
  }
  async presenceUpsert(clientId: string, at: number): Promise<void> {
    await this.exec(SQL.presUp, [clientId, at]);
  }
  async presenceCount(cutoff: number): Promise<number> {
    const r = await this.run<any[]>(SQL.presCnt, [cutoff]);
    return Number(r[0]?.c ?? 0);
  }
  async rateHit(
    bucket: string,
    scope: string,
    windowStart: number,
  ): Promise<number> {
    const r = await this.run<any[]>(SQL.rateHit, [bucket, scope, windowStart]);
    return Number(r[0]?.count ?? 1);
  }
  async messageStats(): Promise<{ total: number; retained: number }> {
    // 口径 = 物理行（含软删占位）；软删不改行数，仅保留裁剪物理删除 → total/retained 恒等，双字段仅为语义区分
    const r = await this.run<any[]>(SQL.stats, []);
    const total = Number(r[0]?.total ?? 0);
    return { total, retained: total };
  }
  async cleanupEvents(before: number): Promise<number> {
    return this.affected(SQL.delEvents, [before]);
  }
  async cleanupPresence(before: number): Promise<number> {
    return this.affected(SQL.delPres, [before]);
  }
  async cleanupRateLimits(before: number): Promise<number> {
    return this.affected(SQL.delRates, [before]);
  }
  async trimMessagesBelow(idFloor: number): Promise<number> {
    return this.affected(SQL.trimBelow, [idFloor]);
  }
  async deleteMessagesOlderThan(cutoff: number): Promise<number> {
    return this.affected(SQL.delOlder, [cutoff]);
  }
  /** 危险操作：白名单档位内的表在同一写事务内全清（部分失败则整体回滚，不留半清状态）。 */
  async clearData(scope: PurgeScope): Promise<PurgeCounts> {
    const tx = await this.c.transaction("write");
    try {
      const deleted = emptyCounts();
      for (const t of PURGE_TABLES[scope]) {
        const r = await tx.execute(DELETE_ALL_SQL[t]);
        deleted[t] = Number(r.rowsAffected);
      }
      await tx.commit();
      return deleted;
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
  }
  async purgeCounts(): Promise<PurgeCounts> {
    const out = emptyCounts();
    for (const t of PURGE_ALL_TABLES) out[t] = await this.countOf(COUNT_SQL[t]);
    return out;
  }
  private async countOf(sql: string): Promise<number> {
    const r = await this.run<any[]>(sql, []);
    return Number(r[0]?.c ?? 0);
  }
  private async affected(sql: string, args: unknown[]): Promise<number> {
    const r = await this.c.execute({ sql, args: args as any[] });
    return Number(r.rowsAffected);
  }
}

class PostgresRepo implements Repo {
  readonly provider = "postgres" as const;
  constructor(private sql: postgres.Sql<{}>) {}
  async bootstrap(): Promise<void> {
    for (const d of ddlFor("postgres")) await this.sql.unsafe(d);
  }
  async close(): Promise<void> {
    await this.sql.end();
  }
  private toPgParams(sql: string, args: any[]) {
    let i = 0;
    const converted = sql.replace(/\?/g, () => `$${++i}`);
    return { sql: converted, args };
  }
  private async query<T>(sql: string, args: unknown[]): Promise<T[]> {
    const { sql: s, args: a } = this.toPgParams(sql, args);
    // SAFETY: postgres.js unsafe 返回 RowList（含 count 元数据、按列解出的 JS 值），此处仅做泛型收口；
    // 具体列契约由各查询调用点的行类型（T 为行类型，如 any / { id: number }）保证。
    return (await this.sql.unsafe(s, a)) as unknown as T[];
  }
  private async exec(sql: string, args: unknown[]): Promise<void> {
    const { sql: s, args: a } = this.toPgParams(sql, args);
    await this.sql.unsafe(s, a);
  }
  /** 危险操作：白名单档位内的表在同一事务内全清（PG 逐表 DELETE，失败整体回滚）。 */
  async clearData(scope: PurgeScope): Promise<PurgeCounts> {
    return await this.sql.begin(async (tx) => {
      const deleted = emptyCounts();
      for (const t of PURGE_TABLES[scope]) {
        const r = await tx.unsafe(DELETE_ALL_SQL[t], []);
        deleted[t] = r.count === undefined ? 0 : Number(r.count);
      }
      return deleted;
    });
  }
  async purgeCounts(): Promise<PurgeCounts> {
    const out = emptyCounts();
    // COUNT(*) 在 PG 里是 bigint → 文本返回，必须 Number() 归一
    for (const t of PURGE_ALL_TABLES) {
      const r = await this.sql.unsafe(COUNT_SQL[t], []);
      out[t] = Number(r[0]?.c ?? 0);
    }
    return out;
  }
  private async countAffected(sql: string, args: unknown[]): Promise<number> {
    const { sql: s, args: a } = this.toPgParams(sql, args);
    const r = await this.sql.unsafe(s, a);
    return r.count === undefined ? 0 : Number(r.count);
  }
  async sendMessageAndEvent(
    m: MessageInput,
  ): Promise<{ messageId: number; eventId: number }> {
    return await this.sql.begin(async (tx) => {
      const insMsg = this.toPgParams(SQL.insMessage + " RETURNING id", [
        m.client_id,
        m.nick,
        m.text,
        m.created_at,
      ]);
      const [msg] = await tx.unsafe(insMsg.sql, insMsg.args);
      const messageId = Number(msg.id);
      const payload = JSON.stringify({
        id: String(messageId),
        client_id: m.client_id,
        nick: m.nick,
        text: m.text,
        created_at: m.created_at,
      });
      const insEv = this.toPgParams(SQL.insEvent + " RETURNING id", [
        "message",
        payload,
        m.created_at,
      ]);
      const [ev] = await tx.unsafe(insEv.sql, insEv.args);
      return { messageId, eventId: Number(ev.id) };
    });
  }

  async publishEphemeralMessage(m: MessageInput): Promise<{ eventId: number }> {
    return await this.sql.begin(async (tx) => {
      const insEv = this.toPgParams(SQL.insEvent + " RETURNING id", [
        "message",
        "",
        m.created_at,
      ]);
      const [ev] = await tx.unsafe(insEv.sql, insEv.args);
      const eventId = Number(ev.id);
      const payload = JSON.stringify({
        id: `e${eventId}`,
        client_id: m.client_id,
        nick: m.nick,
        text: m.text,
        created_at: m.created_at,
      });
      const upd = this.toPgParams(SQL.updEventPayload, [payload, eventId]);
      await tx.unsafe(upd.sql, upd.args);
      return { eventId };
    });
  }
  async insertEvent(
    type: string,
    payload: string,
    created_at: number,
  ): Promise<number> {
    const r = await this.query<{ id: number }>(SQL.insEvent + " RETURNING id", [
      type,
      payload,
      created_at,
    ]);
    return Number(r[0]?.id ?? 0);
  }
  async eventsSince(since: number, limit: number): Promise<EventRow[]> {
    return (await this.query<any>(SQL.eventsSince, [since, limit])).map(
      mapEvent,
    );
  }
  async eventsMaxId(): Promise<number> {
    const r = await this.query<{ m: number | string }>(SQL.maxEventId, []);
    return Number(r[0]?.m ?? 0);
  }
  async historyBefore(before: number, limit: number): Promise<MessageRow[]> {
    return (await this.query<any>(SQL.before, [before, limit])).map(mapMessage);
  }
  async historySince(since: number, limit: number): Promise<MessageRow[]> {
    return (await this.query<any>(SQL.since, [since, limit])).map(mapMessage);
  }
  async softDeleteMessage(
    id: number,
    by: string,
    at: number,
  ): Promise<boolean> {
    return (await this.countAffected(SQL.softDel, [at, by, id])) > 0;
  }
  /** true = 新建封禁；false = 已存在（本次覆盖更新）。RETURNING (xmax = 0) 区分分支。 */
  async banUpsert(
    ip: string,
    reason: string,
    by: string,
    at: number,
  ): Promise<boolean> {
    const r = await this.query<{ inserted: boolean }>(banUpsertPg, [
      ip,
      reason,
      by,
      at,
    ]);
    return r[0]?.inserted === true;
  }
  async banGet(
    ip: string,
  ): Promise<{ reason: string; created_at: number } | null> {
    const r = await this.query<any>(SQL.banGet, [ip]);
    return r[0]
      ? { reason: r[0].reason, created_at: Number(r[0].created_at) }
      : null;
  }
  async banList(limit: number, offset: number): Promise<BanRow[]> {
    return (await this.query<any>(SQL.banList, [limit, offset])).map((r) => ({
      ip: r.ip,
      reason: r.reason,
      created_at: Number(r.created_at),
    }));
  }
  async banRemove(ip: string): Promise<boolean> {
    return (await this.countAffected(SQL.banDel, [ip])) > 0;
  }
  async presenceUpsert(clientId: string, at: number): Promise<void> {
    await this.exec(SQL.presUp, [clientId, at]);
  }
  async presenceCount(cutoff: number): Promise<number> {
    const r = await this.query<{ c: number | string }>(SQL.presCnt, [cutoff]);
    return Number(r[0]?.c ?? 0);
  }
  async rateHit(
    bucket: string,
    scope: string,
    windowStart: number,
  ): Promise<number> {
    const r = await this.query<{ count: number | string }>(SQL.rateHit, [
      bucket,
      scope,
      windowStart,
    ]);
    return Number(r[0]?.count ?? 1);
  }
  async messageStats(): Promise<{ total: number; retained: number }> {
    // 口径同 sqlite：物理行（含软删占位），total/retained 恒等
    const r = await this.query<{ total: number | string }>(SQL.stats, []);
    const total = Number(r[0]?.total ?? 0);
    return { total, retained: total };
  }
  async cleanupEvents(before: number): Promise<number> {
    return this.countAffected(SQL.delEvents, [before]);
  }
  async cleanupPresence(before: number): Promise<number> {
    return this.countAffected(SQL.delPres, [before]);
  }
  async cleanupRateLimits(before: number): Promise<number> {
    return this.countAffected(SQL.delRates, [before]);
  }
  async trimMessagesBelow(idFloor: number): Promise<number> {
    return this.countAffected(SQL.trimBelow, [idFloor]);
  }
  async deleteMessagesOlderThan(cutoff: number): Promise<number> {
    return this.countAffected(SQL.delOlder, [cutoff]);
  }
}

/**
 * 纯内存驱动（DB_PROVIDER=memory）：无外部依赖、不持久化、单线程内原子（方法内无 await →
 * 无并发交错，等价 sqlite 事务双写）。语义逐方法镜像 sqlite 实现（排序/裁剪/口径/事件载荷）。
 * 仅限本地/单实例演示与测试 —— Vercel/Serverless 多实例无共享内存，生产由 loadConfig 拒绝。
 */
interface MemMessage {
  id: number;
  client_id: string;
  nick: string;
  text: string;
  created_at: number;
  deleted_at: number | null;
  deleted_by: string | null;
}
interface MemEvent {
  id: number;
  type: string;
  payload: string;
  created_at: number;
}
class MemoryRepo implements Repo {
  readonly provider = "memory" as const;
  private msgSeq = 0;
  private evSeq = 0;
  private messages: MemMessage[] = [];
  private events: MemEvent[] = [];
  private presence = new Map<string, number>();
  private bans = new Map<
    string,
    { reason: string; banned_by: string; created_at: number }
  >();
  private rates = new Map<string, number>();

  async bootstrap(): Promise<void> {
    // 无 schema
  }
  async close(): Promise<void> {
    // 无连接
  }

  async sendMessageAndEvent(
    m: MessageInput,
  ): Promise<{ messageId: number; eventId: number }> {
    const messageId = ++this.msgSeq;
    this.messages.push({
      id: messageId,
      client_id: m.client_id,
      nick: m.nick,
      text: m.text,
      created_at: m.created_at,
      deleted_at: null,
      deleted_by: null,
    });
    // 事件载荷由实现在拿到 messageId 后自动构造（同 sqlite/pg：含 id 供客户端去重/对应 delete）
    const eventId = ++this.evSeq;
    this.events.push({
      id: eventId,
      type: "message",
      payload: JSON.stringify({
        id: String(messageId),
        client_id: m.client_id,
        nick: m.nick,
        text: m.text,
        created_at: m.created_at,
      }),
      created_at: m.created_at,
    });
    return { messageId, eventId };
  }

  async publishEphemeralMessage(m: MessageInput): Promise<{ eventId: number }> {
    const eventId = ++this.evSeq;
    this.events.push({
      id: eventId,
      type: "message",
      payload: JSON.stringify({
        id: `e${eventId}`, // 避开 messages.id 命名空间（同 sqlite/pg 实现）
        client_id: m.client_id,
        nick: m.nick,
        text: m.text,
        created_at: m.created_at,
      }),
      created_at: m.created_at,
    });
    return { eventId };
  }

  async insertEvent(
    type: string,
    payload: string,
    created_at: number,
  ): Promise<number> {
    const eventId = ++this.evSeq;
    this.events.push({ id: eventId, type, payload, created_at });
    return eventId;
  }
  async eventsSince(since: number, limit: number): Promise<EventRow[]> {
    // events 按 id 递增 push → 过滤保持旧→新序，等价 SQL ORDER BY id ASC LIMIT
    return this.events
      .filter((e) => e.id > since)
      .slice(0, limit)
      .map(mapEvent);
  }
  async eventsMaxId(): Promise<number> {
    return this.events.length ? this.events[this.events.length - 1].id : 0;
  }
  async historyBefore(before: number, limit: number): Promise<MessageRow[]> {
    return this.messages
      .filter((r) => r.id < before)
      .sort((a, b) => b.id - a.id) // 新→旧，等价 ORDER BY id DESC
      .slice(0, limit)
      .map(mapMessage);
  }
  async historySince(since: number, limit: number): Promise<MessageRow[]> {
    return this.messages
      .filter((r) => r.id > since)
      .sort((a, b) => a.id - b.id)
      .slice(0, limit)
      .map(mapMessage);
  }
  async softDeleteMessage(
    id: number,
    by: string,
    at: number,
  ): Promise<boolean> {
    const row = this.messages.find((r) => r.id === id && r.deleted_at === null);
    if (!row) return false;
    row.deleted_at = at;
    row.deleted_by = by;
    row.text = ""; // 同 sqlite：清 text（mapMessage 依 deleted_at 归 null/deleted）
    return true;
  }
  async banUpsert(
    ip: string,
    reason: string,
    by: string,
    at: number,
  ): Promise<boolean> {
    const existed = this.bans.has(ip);
    this.bans.set(ip, { reason, banned_by: by, created_at: at });
    return !existed;
  }
  async banGet(
    ip: string,
  ): Promise<{ reason: string; created_at: number } | null> {
    const b = this.bans.get(ip);
    return b ? { reason: b.reason, created_at: b.created_at } : null;
  }
  async banList(limit: number, offset: number): Promise<BanRow[]> {
    // created_at DESC；同刻 tie-break ip DESC（确定性，优于 sqlite 未定义序）
    return [...this.bans.entries()]
      .map(([ip, b]) => ({ ip, reason: b.reason, created_at: b.created_at }))
      .sort(
        (a, b) =>
          b.created_at - a.created_at ||
          (a.ip < b.ip ? 1 : a.ip > b.ip ? -1 : 0),
      )
      .slice(offset, offset + limit);
  }
  async banRemove(ip: string): Promise<boolean> {
    return this.bans.delete(ip);
  }
  async presenceUpsert(clientId: string, at: number): Promise<void> {
    this.presence.set(clientId, at);
  }
  async presenceCount(cutoff: number): Promise<number> {
    let n = 0;
    for (const at of this.presence.values()) if (at > cutoff) n++;
    return n;
  }
  async rateHit(
    bucket: string,
    scope: string,
    windowStart: number,
  ): Promise<number> {
    const k = `${bucket}\u0000${scope}\u0000${windowStart}`;
    const count = (this.rates.get(k) ?? 0) + 1;
    this.rates.set(k, count);
    return count;
  }
  async messageStats(): Promise<{ total: number; retained: number }> {
    // 物理行口径（同 sqlite/pg）：软删不删行 → total/retained 恒等
    const total = this.messages.length;
    return { total, retained: total };
  }
  async cleanupEvents(before: number): Promise<number> {
    const len = this.events.length;
    this.events = this.events.filter((e) => e.created_at >= before);
    return len - this.events.length;
  }
  async cleanupPresence(before: number): Promise<number> {
    let n = 0;
    for (const [k, v] of this.presence) {
      if (v < before) {
        this.presence.delete(k);
        n++;
      }
    }
    return n;
  }
  async cleanupRateLimits(before: number): Promise<number> {
    let n = 0;
    for (const k of this.rates.keys()) {
      if (Number(k.split("\u0000")[2]) < before) {
        this.rates.delete(k);
        n++;
      }
    }
    return n;
  }
  async trimMessagesBelow(idFloor: number): Promise<number> {
    const len = this.messages.length;
    this.messages = this.messages.filter((r) => r.id >= idFloor);
    return len - this.messages.length;
  }
  async deleteMessagesOlderThan(cutoff: number): Promise<number> {
    const len = this.messages.length;
    this.messages = this.messages.filter((r) => r.created_at >= cutoff);
    return len - this.messages.length;
  }
  async purgeCounts(): Promise<PurgeCounts> {
    return this.countsNow();
  }
  async clearData(scope: PurgeScope): Promise<PurgeCounts> {
    // 单线程 JS：逐表清空不具备“半清”窗口，无需事务
    const before = this.countsNow();
    const deleted = emptyCounts();
    for (const t of PURGE_TABLES[scope]) {
      switch (t) {
        case "messages":
          this.messages = [];
          break;
        case "events":
          this.events = [];
          break;
        case "presence":
          this.presence.clear();
          break;
        case "rate_limits":
          this.rates.clear();
          break;
        case "bans":
          this.bans.clear();
          break;
      }
      deleted[t] = before[t];
    }
    return deleted;
  }
  private countsNow(): PurgeCounts {
    return {
      messages: this.messages.length,
      events: this.events.length,
      presence: this.presence.size,
      rate_limits: this.rates.size,
      bans: this.bans.size,
    };
  }
}

export async function createRepo(
  provider: Provider,
  databaseUrl: string,
  authToken?: string,
): Promise<Repo> {
  if (provider === "memory") {
    return new MemoryRepo();
  }
  if (provider === "sqlite") {
    return new SqliteRepo(createClient({ url: databaseUrl, authToken }));
  }
  const ssl = /[?&]sslmode=require/.test(databaseUrl) ? "require" : false;
  return new PostgresRepo(postgres(databaseUrl, { ssl, max: 1 }));
}
