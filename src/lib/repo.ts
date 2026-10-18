import { createClient, type Client, type InValue } from "@libsql/client";
import postgres from "postgres";
import type { AppConfig, Provider } from "./config";
import { ddlFor } from "./ddl";
import {
  deleteEventPayload,
  ephemeralMessageId,
  messageEventPayload,
} from "./events";
import type { RateSink } from "./limits";
import type {
  BanStore,
  EventOutbox,
  MaintenanceStore,
  MessageStore,
  PresenceStore,
  PurgeStore,
} from "./ports";
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

export interface Repo
  extends MessageStore,
    EventOutbox,
    PresenceStore,
    BanStore,
    PurgeStore,
    MaintenanceStore,
    RateSink {
  readonly provider: Provider;
  bootstrap(): Promise<void>;
  close(): Promise<void>;
}

/** 驱动返回的行：列名未知、值未知，收窄责任落在下面的助手函数上。 */
type Row = Record<string, unknown>;

/**
 * 驱动边界：postgres.js 的 unsafe() 只接受它自己的参数类型，与 unknown[] 没有交集。
 * 参数语义由调用点的 SQL 决定，所以在这里做唯一一次显式转换，而不是在各个调用点逃逸类型。
 */
const asPgArgs = (args: readonly unknown[]) => args as unknown as never[];

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isNullish = (v: unknown): boolean => v === null || v === undefined;
const nullableNum = (v: unknown): number | null =>
  isNullish(v) ? null : num(v);

const mapMessage = (r: Row): MessageRow => ({
  id: num(r.id),
  client_id: str(r.client_id),
  nick: str(r.nick),
  text: isNullish(r.deleted_at) ? str(r.text) : null,
  created_at: num(r.created_at),
  deleted: !isNullish(r.deleted_at),
  deleted_at: nullableNum(r.deleted_at),
});

/** PG returns bigint columns as strings, so both drivers normalize ids/timestamps to number. */
const mapEvent = (r: Row): EventRow => ({
  id: num(r.id),
  type: str(r.type),
  payload: str(r.payload),
  created_at: num(r.created_at),
});

// Portable templates using ? placeholders; each dialect appends RETURNING or wraps in a tx.
const SQL = {
  insMessage:
    "INSERT INTO messages (client_id, nick, text, created_at) VALUES (?, ?, ?, ?)",
  insEvent: "INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)",
  eventsSince: "SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?",
  maxEventId: "SELECT COALESCE(MAX(id), 0) AS m FROM events",
  before: "SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?",
  idAtOffset: "SELECT id FROM messages ORDER BY id DESC LIMIT 1 OFFSET ?",
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
  cntMessages: "SELECT COUNT(*) AS c FROM messages",
  cntEvents: "SELECT COUNT(*) AS c FROM events",
  cntPresence: "SELECT COUNT(*) AS c FROM presence",
  cntBans: "SELECT COUNT(*) AS c FROM bans",
  cntRateLimits: "SELECT COUNT(*) AS c FROM rate_limits",
};

const DELETE_ALL_SQL: Record<PurgeTable, string> = {
  messages: "DELETE FROM messages",
  events: "DELETE FROM events",
  presence: "DELETE FROM presence",
  rate_limits: "DELETE FROM rate_limits",
  bans: "DELETE FROM bans",
};

/**
 * rate_limits 里的 purge_used 是单次令牌的安全账本：清库不能连它一起清，
 * 否则同一令牌在清库后又能重放一次。
 */
const DELETE_RATES_KEEP_NONCE =
  "DELETE FROM rate_limits WHERE bucket <> 'purge_used'";

/** 清表语句：rate_limits 需要特例，其余走 DELETE_ALL_SQL。 */
const deleteSqlFor = (t: PurgeTable) =>
  t === "rate_limits" ? DELETE_RATES_KEEP_NONCE : DELETE_ALL_SQL[t];

const COUNT_SQL: Record<PurgeTable, string> = {
  messages: SQL.cntMessages,
  events: SQL.cntEvents,
  presence: SQL.cntPresence,
  rate_limits: SQL.cntRateLimits,
  bans: SQL.cntBans,
};

const emptyCounts = (): PurgeCounts => ({
  messages: 0,
  events: 0,
  presence: 0,
  rate_limits: 0,
  bans: 0,
});

/** PG only: xmax = 0 means this statement inserted the row (true = newly created). */
const banUpsertPg = `INSERT INTO bans (ip, reason, banned_by, created_at) VALUES (?, ?, ?, ?)
  ON CONFLICT (ip) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by, created_at = excluded.created_at
  RETURNING (xmax = 0) AS inserted`;

const BAN_EXISTS = "SELECT 1 AS x FROM bans WHERE ip = ?";

class SqliteRepo implements Repo {
  readonly provider = "sqlite" as const;
  constructor(private c: Client) {}
  async bootstrap(): Promise<void> {
    // One round trip: libsql batch() ships the whole idempotent DDL in a single request.
    await this.c.batch([...ddlFor("sqlite")], "write");
  }
  async ping(): Promise<void> {
    await this.c.execute("SELECT 1");
  }
  async schemaInfo(): Promise<{ version: number; indexes: string[] }> {
    const idx = await this.c.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'",
    );
    const v = await this.c.execute(
      "SELECT MAX(version) AS v FROM schema_version",
    );
    return {
      version: Number(v.rows[0]?.v ?? 0),
      indexes: idx.rows.map((r) => String(r.name)),
    };
  }

  async close(): Promise<void> {
    this.c.close();
  }
  private async run<T>(sql: string, args: unknown[]): Promise<T> {
    const r = await this.c.execute({ sql, args: args as InValue[] });
    // SAFETY: libsql returns primitives; the caller's row type does the normalization.
    return r.rows as unknown as T;
  }
  private async exec(sql: string, args: unknown[] = []): Promise<void> {
    await this.c.execute({ sql, args: args as InValue[] });
  }

  async sendMessageAndEvent(
    m: MessageInput,
  ): Promise<{ messageId: number; eventId: number }> {
    // BEGIN IMMEDIATE: plain execute() auto-commits per statement, so writes go through a tx.
    const tx = await this.c.transaction("write");
    try {
      const ins = await tx.execute({
        sql: SQL.insMessage,
        args: [m.client_id, m.nick, m.text, m.created_at],
      });
      const messageId = Number(ins.lastInsertRowid);
      const payload = JSON.stringify(messageEventPayload(m, messageId));
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

  async publishEphemeralMessage(
    m: MessageInput,
  ): Promise<{ messageId: string }> {
    // 先插占位再 UPDATE 的写法要两次写 + 一个事务；id 直接由进程生成就只需一次。
    const id = ephemeralMessageId();
    const payload = JSON.stringify(messageEventPayload(m, id));
    await this.insertEvent("message", payload, m.created_at);
    return { messageId: id };
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
    return (await this.run<Row[]>(SQL.eventsSince, [since, limit])).map(
      mapEvent,
    );
  }
  async eventsMaxId(): Promise<number> {
    const r = await this.run<Row[]>(SQL.maxEventId, []);
    return Number(r[0]?.m ?? 0);
  }
  async historyBefore(before: number, limit: number): Promise<MessageRow[]> {
    return (await this.run<Row[]>(SQL.before, [before, limit])).map(mapMessage);
  }
  async idAtOffset(offset: number): Promise<number | null> {
    const r = await this.run<{ id: number }[]>(SQL.idAtOffset, [offset]);
    return r[0] ? Number(r[0].id) : null;
  }
  async historySince(since: number, limit: number): Promise<MessageRow[]> {
    return (await this.run<Row[]>(SQL.since, [since, limit])).map(mapMessage);
  }
  async softDeleteMessageAndEvent(
    id: number,
    by: string,
    at: number,
  ): Promise<boolean> {
    // 删与广播必须同生共死：分两次写会出现「删了但客户端仍看到」或反过来的脏窗口。
    const tx = await this.c.transaction("write");
    try {
      const r = await tx.execute({ sql: SQL.softDel, args: [at, by, id] });
      if (Number(r.rowsAffected) === 0) {
        await tx.rollback();
        return false;
      }
      await tx.execute({
        sql: SQL.insEvent,
        args: ["delete", JSON.stringify(deleteEventPayload(id)), at],
      });
      await tx.commit();
      return true;
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
  }
  /** Upsert rowsAffected is always 1 here, so existence is checked inside a write tx (atomic). */
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
    const r = await this.run<Row[]>(SQL.banGet, [ip]);
    return r[0]
      ? { reason: str(r[0].reason), created_at: num(r[0].created_at) }
      : null;
  }
  async banList(limit: number, offset: number): Promise<BanRow[]> {
    return this.run<Row[]>(SQL.banList, [limit, offset]).then((rs) =>
      rs.map((r) => ({
        ip: str(r.ip),
        reason: str(r.reason),
        created_at: num(r.created_at),
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
    const r = await this.run<Row[]>(SQL.presCnt, [cutoff]);
    return Number(r[0]?.c ?? 0);
  }
  async rateHit(
    bucket: string,
    scope: string,
    windowStart: number,
  ): Promise<number> {
    const r = await this.run<Row[]>(SQL.rateHit, [bucket, scope, windowStart]);
    return Number(r[0]?.count ?? 1);
  }
  async messageStats(): Promise<{ total: number; retained: number }> {
    const r = await this.run<Row[]>(SQL.stats, []);
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
  /** All-or-nothing: the scope's tables are cleared in a single write tx. */
  async clearData(scope: PurgeScope): Promise<PurgeCounts> {
    const tx = await this.c.transaction("write");
    try {
      const deleted = emptyCounts();
      for (const t of PURGE_TABLES[scope]) {
        const r = await tx.execute(deleteSqlFor(t));
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
    const r = await this.run<Row[]>(sql, []);
    return Number(r[0]?.c ?? 0);
  }
  private async affected(sql: string, args: unknown[]): Promise<number> {
    const r = await this.c.execute({ sql, args: args as InValue[] });
    return Number(r.rowsAffected);
  }
}

class PostgresRepo implements Repo {
  readonly provider = "postgres" as const;
  constructor(private sql: postgres.Sql<Record<string, never>>) {}
  async bootstrap(): Promise<void> {
    for (const d of ddlFor("postgres")) await this.sql.unsafe(d);
  }
  async ping(): Promise<void> {
    await this.sql.unsafe("SELECT 1");
  }
  async schemaInfo(): Promise<{ version: number; indexes: string[] }> {
    const idx = await this.sql.unsafe(
      "SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema()",
    );
    const v = await this.sql.unsafe(
      "SELECT MAX(version) AS v FROM schema_version",
    );
    return {
      version: Number(v[0]?.v ?? 0),
      indexes: idx.map((r) => String(r.name)),
    };
  }
  async close(): Promise<void> {
    await this.sql.end();
  }
  private toPgParams(sql: string, args: readonly unknown[]) {
    let i = 0;
    const converted = sql.replace(/\?/g, () => `$${++i}`);
    return { sql: converted, args };
  }
  private async query<T>(sql: string, args: unknown[]): Promise<T[]> {
    const { sql: s, args: a } = this.toPgParams(sql, args);
    // SAFETY: postgres.js unsafe() returns a RowList; column contracts live at the call sites.
    return (await this.sql.unsafe(s, asPgArgs(a))) as unknown as T[];
  }
  private async exec(sql: string, args: unknown[]): Promise<void> {
    const { sql: s, args: a } = this.toPgParams(sql, args);
    await this.sql.unsafe(s, asPgArgs(a));
  }
  async clearData(scope: PurgeScope): Promise<PurgeCounts> {
    return await this.sql.begin(async (tx) => {
      const deleted = emptyCounts();
      for (const t of PURGE_TABLES[scope]) {
        const r = await tx.unsafe(deleteSqlFor(t), []);
        deleted[t] = r.count === undefined ? 0 : Number(r.count);
      }
      return deleted;
    });
  }
  async purgeCounts(): Promise<PurgeCounts> {
    const out = emptyCounts();
    // PG returns COUNT(*) (bigint) as a string, so Number() it.
    for (const t of PURGE_ALL_TABLES) {
      const r = await this.sql.unsafe(COUNT_SQL[t], []);
      out[t] = Number(r[0]?.c ?? 0);
    }
    return out;
  }
  private async countAffected(sql: string, args: unknown[]): Promise<number> {
    const { sql: s, args: a } = this.toPgParams(sql, args);
    const r = await this.sql.unsafe(s, asPgArgs(a));
    return r.count === undefined ? 0 : num(r.count);
  }
  async sendMessageAndEvent(
    m: MessageInput,
  ): Promise<{ messageId: number; eventId: number }> {
    return await this.sql.begin(async (tx) => {
      const insMsg = this.toPgParams(`${SQL.insMessage} RETURNING id`, [
        m.client_id,
        m.nick,
        m.text,
        m.created_at,
      ]);
      const [msg] = await tx.unsafe(insMsg.sql, asPgArgs(insMsg.args));
      const messageId = Number(msg.id);
      const payload = JSON.stringify(messageEventPayload(m, messageId));
      const insEv = this.toPgParams(`${SQL.insEvent} RETURNING id`, [
        "message",
        payload,
        m.created_at,
      ]);
      const [ev] = await tx.unsafe(insEv.sql, asPgArgs(insEv.args));
      return { messageId, eventId: Number(ev.id) };
    });
  }

  async publishEphemeralMessage(
    m: MessageInput,
  ): Promise<{ messageId: string }> {
    const id = ephemeralMessageId();
    const payload = JSON.stringify(messageEventPayload(m, id));
    await this.insertEvent("message", payload, m.created_at);
    return { messageId: id };
  }
  async insertEvent(
    type: string,
    payload: string,
    created_at: number,
  ): Promise<number> {
    const r = await this.query<{ id: number }>(`${SQL.insEvent} RETURNING id`, [
      type,
      payload,
      created_at,
    ]);
    return Number(r[0]?.id ?? 0);
  }
  async eventsSince(since: number, limit: number): Promise<EventRow[]> {
    return (await this.query<Row>(SQL.eventsSince, [since, limit])).map(
      mapEvent,
    );
  }
  async eventsMaxId(): Promise<number> {
    const r = await this.query<{ m: number | string }>(SQL.maxEventId, []);
    return Number(r[0]?.m ?? 0);
  }
  async historyBefore(before: number, limit: number): Promise<MessageRow[]> {
    return (await this.query<Row>(SQL.before, [before, limit])).map(mapMessage);
  }
  async idAtOffset(offset: number): Promise<number | null> {
    const r = await this.query<{ id: number }>(SQL.idAtOffset, [offset]);
    return r[0] ? Number(r[0].id) : null;
  }
  async historySince(since: number, limit: number): Promise<MessageRow[]> {
    return (await this.query<Row>(SQL.since, [since, limit])).map(mapMessage);
  }
  async softDeleteMessageAndEvent(
    id: number,
    by: string,
    at: number,
  ): Promise<boolean> {
    return await this.sql.begin(async (tx) => {
      const del = this.toPgParams(SQL.softDel, [at, by, id]);
      const r = await tx.unsafe(del.sql, asPgArgs(del.args));
      if (!r.count) return false;
      const ins = this.toPgParams(SQL.insEvent, [
        "delete",
        JSON.stringify(deleteEventPayload(id)),
        at,
      ]);
      await tx.unsafe(ins.sql, asPgArgs(ins.args));
      return true;
    });
  }
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
    const r = await this.query<Row>(SQL.banGet, [ip]);
    return r[0]
      ? { reason: str(r[0].reason), created_at: num(r[0].created_at) }
      : null;
  }
  async banList(limit: number, offset: number): Promise<BanRow[]> {
    return (await this.query<Row>(SQL.banList, [limit, offset])).map((r) => ({
      ip: str(r.ip),
      reason: str(r.reason),
      created_at: num(r.created_at),
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

/** In-memory driver for local/single-instance use only; loadConfig refuses it in production. */
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
/** 内存实现手里已是强类型对象，直接投影，不必经过驱动边界的 Row 收窄。 */
const memMessageRow = (m: MemMessage): MessageRow => ({
  id: m.id,
  client_id: m.client_id,
  nick: m.nick,
  text: isNullish(m.deleted_at) ? m.text : null,
  created_at: m.created_at,
  deleted: !isNullish(m.deleted_at),
  deleted_at: m.deleted_at,
});
const memEventRow = (e: MemEvent): EventRow => ({
  id: e.id,
  type: e.type,
  payload: e.payload,
  created_at: e.created_at,
});

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

  async bootstrap(): Promise<void> {}
  async ping(): Promise<void> {}
  async schemaInfo(): Promise<{ version: number; indexes: string[] }> {
    // 内存实现没有真实索引，但契约要一致，测试替身才可互换。
    return {
      version: 1,
      indexes: ["idx_events_created_at", "idx_rate_limits_window"],
    };
  }
  async close(): Promise<void> {}

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
    const eventId = ++this.evSeq;
    this.events.push({
      id: eventId,
      type: "message",
      payload: JSON.stringify(messageEventPayload(m, messageId)),
      created_at: m.created_at,
    });
    return { messageId, eventId };
  }

  async publishEphemeralMessage(
    m: MessageInput,
  ): Promise<{ messageId: string }> {
    const id = ephemeralMessageId();
    const payload = JSON.stringify(messageEventPayload(m, id));
    await this.insertEvent("message", payload, m.created_at);
    return { messageId: id };
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
    // push order is id-ASC, so filtering matches SQL ORDER BY id ASC LIMIT.
    return this.events
      .filter((e) => e.id > since)
      .slice(0, limit)
      .map(memEventRow);
  }
  async eventsMaxId(): Promise<number> {
    return this.events.length ? this.events[this.events.length - 1].id : 0;
  }
  async idAtOffset(offset: number): Promise<number | null> {
    const sorted = [...this.messages].sort((a, b) => b.id - a.id);
    const m = sorted[offset];
    return m ? m.id : null;
  }
  async historyBefore(before: number, limit: number): Promise<MessageRow[]> {
    return this.messages
      .filter((r) => r.id < before)
      .sort((a, b) => b.id - a.id) // matches ORDER BY id DESC
      .slice(0, limit)
      .map(memMessageRow);
  }
  async historySince(since: number, limit: number): Promise<MessageRow[]> {
    return this.messages
      .filter((r) => r.id > since)
      .sort((a, b) => a.id - b.id)
      .slice(0, limit)
      .map(memMessageRow);
  }
  async softDeleteMessageAndEvent(
    id: number,
    by: string,
    at: number,
  ): Promise<boolean> {
    const row = this.messages.find((r) => r.id === id && r.deleted_at === null);
    if (!row) return false;
    row.deleted_at = at;
    row.deleted_by = by;
    row.text = ""; // same as sqlite: mapMessage derives null from deleted_at
    await this.insertEvent(
      "delete",
      JSON.stringify(deleteEventPayload(id)),
      at,
    );
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
    // created_at DESC then ip DESC: deterministic ties (sqlite order is undefined).
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
    // Single-threaded: per-table clears have no half-clear window, so no tx is needed.
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
          // 同 SQL 层：purge_used 账本行必须活着，否则令牌可跨清库重放。
          for (const k of [...this.rates.keys()])
            if (!k.startsWith("purge_used\u0000")) this.rates.delete(k);
          break;
        case "bans":
          this.bans.clear();
          break;
      }
      deleted[t] = before[t];
    }
    // purge_used 账本行存活，所以 rate_limits 的实际删除数不是清空前的行数。
    if (scope === "full")
      deleted.rate_limits = Math.max(0, before.rate_limits - this.rates.size);
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

export interface PgOptions {
  max: number;
  prepare: boolean;
  idleTimeoutSec: number;
  connectTimeoutSec: number;
}

export interface RepoOptions {
  authToken?: string;
  pg?: PgOptions;
}

const PG_DEFAULTS: PgOptions = {
  max: 1,
  prepare: true,
  idleTimeoutSec: 20,
  connectTimeoutSec: 10,
};

export function pgOptions(
  cfg: Pick<
    AppConfig,
    "pgPoolMax" | "pgPrepare" | "pgIdleTimeoutS" | "pgConnectTimeoutS"
  >,
): PgOptions {
  return {
    max: cfg.pgPoolMax,
    prepare: cfg.pgPrepare,
    idleTimeoutSec: cfg.pgIdleTimeoutS,
    connectTimeoutSec: cfg.pgConnectTimeoutS,
  };
}

export async function createRepo(
  provider: Provider,
  databaseUrl: string,
  o: RepoOptions = {},
): Promise<Repo> {
  if (provider === "memory") {
    return new MemoryRepo();
  }
  if (provider === "sqlite") {
    return new SqliteRepo(
      createClient({ url: databaseUrl, authToken: o.authToken }),
    );
  }
  const ssl = /[?&]sslmode=require/.test(databaseUrl) ? "require" : false;
  const pg = o.pg ?? PG_DEFAULTS;
  return new PostgresRepo(
    postgres(databaseUrl, {
      ssl,
      max: pg.max,
      prepare: pg.prepare,
      // postgres.js 用秒，且参数名是 snake_case。
      idle_timeout: pg.idleTimeoutSec,
      connect_timeout: pg.connectTimeoutSec,
    }),
  );
}
