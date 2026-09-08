import { createClient, type Client } from "@libsql/client";
import postgres from "postgres";
import type { Provider } from "./config";
import { ddlFor } from "./ddl";

export interface MessageRow {
  id: number; client_id: string; nick: string;
  text: string | null; created_at: number;
  deleted: boolean; deleted_at: number | null;
}
export interface EventRow { id: number; type: string; payload: string; created_at: number }

export interface MessageInput { client_id: string; nick: string; text: string; created_at: number }
export interface BanRow { ip: string; reason: string; created_at: number }

export interface Repo {
  readonly provider: Provider;
  bootstrap(): Promise<void>;
  close(): Promise<void>;
  /** events + messages 单事务双写（SQLite BEGIN IMMEDIATE / PG begin）。
   * 事件类型恒为 message；payload 由实现**在事务内拿到 messageId 后自动构造**：
   * `{id: String(messageId), client_id, nick, text, created_at}`（含 id 供客户端去重/对应 delete）。 */
  sendMessageAndEvent(m: MessageInput): Promise<{ messageId: number; eventId: number }>;
  /** 仅实时（ephemeral 模式，§7.2）广播：只写 events、不写 messages；payload id 形如 "e<eventId>"（避开 messages.id 命名空间，避免 delete 误伤）。
   * 内部先插空 payload 取 eventId，再在**同一事务**内 UPDATE 为完整 JSON。 */
  publishEphemeralMessage(m: MessageInput): Promise<{ eventId: number }>;
  insertEvent(type: string, payload: string, created_at: number): Promise<number>;
  eventsSince(since: number, limit: number): Promise<EventRow[]>;
  eventsMaxId(): Promise<number>;
  historyBefore(before: number, limit: number): Promise<MessageRow[]>;
  historySince(since: number, limit: number): Promise<MessageRow[]>;
  softDeleteMessage(id: number, by: string, at: number): Promise<boolean>;
  banUpsert(ip: string, reason: string, by: string, at: number): Promise<boolean>;
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
}

const mapMessage = (r: any): MessageRow => ({
  id: Number(r.id), client_id: r.client_id, nick: r.nick,
  text: r.deleted_at === null || r.deleted_at === undefined ? r.text : null,
  created_at: Number(r.created_at), deleted: !(r.deleted_at === null || r.deleted_at === undefined),
  deleted_at: r.deleted_at === null || r.deleted_at === undefined ? null : Number(r.deleted_at),
});

// SQL 模板（仅含 ? 占位；SELECT 后追 RETURNING/双写事务语句按方言微调，见 impl）
const SQL = {
  insMessage: "INSERT INTO messages (client_id, nick, text, created_at) VALUES (?, ?, ?, ?)",
  insEvent: "INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)",
  eventsSince: "SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?",
  maxEventId: "SELECT COALESCE(MAX(id), 0) AS m FROM events",
  before: "SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?",
  since: "SELECT * FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?",
  softDel: "UPDATE messages SET deleted_at = ?, deleted_by = ?, text = '' WHERE id = ? AND deleted_at IS NULL",
  banInsert: "INSERT INTO bans (ip, reason, banned_by, created_at) VALUES (?, ?, ?, ?)",
  banUpdate: "UPDATE bans SET reason = ?, banned_by = ?, created_at = ? WHERE ip = ?",
  banGet: "SELECT reason, created_at FROM bans WHERE ip = ?",
  banList: "SELECT ip, reason, created_at FROM bans ORDER BY created_at DESC LIMIT ? OFFSET ?",
  banDel: "DELETE FROM bans WHERE ip = ?",
  presUp: "INSERT INTO presence (client_id, last_seen) VALUES (?, ?) ON CONFLICT (client_id) DO UPDATE SET last_seen = excluded.last_seen",
  presCnt: "SELECT COUNT(*) AS c FROM presence WHERE last_seen > ?",
  rateHit: `INSERT INTO rate_limits (bucket, scope, window_start, count) VALUES (?, ?, ?, 1)
            ON CONFLICT (bucket, scope, window_start) DO UPDATE SET count = count + 1 RETURNING count`,
  stats: "SELECT COUNT(*) AS total FROM messages",
  delEvents: "DELETE FROM events WHERE created_at < ?",
  delPres: "DELETE FROM presence WHERE last_seen < ?",
  delRates: "DELETE FROM rate_limits WHERE window_start < ?",
  trimBelow: "DELETE FROM messages WHERE id < ?",
  delOlder: "DELETE FROM messages WHERE created_at < ?",
};

/** PG 专用：借助 xmax=0（本语句新插入）区分「新增」与「冲突后更新」，实现 true=新建/false=已存在。 */
const banUpsertPg = `INSERT INTO bans (ip, reason, banned_by, created_at) VALUES (?, ?, ?, ?)
  ON CONFLICT (ip) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by, created_at = excluded.created_at
  RETURNING (xmax = 0) AS inserted`;

const BAN_EXISTS = "SELECT 1 AS x FROM bans WHERE ip = ?";

class SqliteRepo implements Repo {
  readonly provider = "sqlite" as const;
  constructor(private c: Client) {}
  async bootstrap(): Promise<void> { for (const d of ddlFor("sqlite")) await this.c.execute(d); }
  async close(): Promise<void> { this.c.close(); }
  private async run<T>(sql: string, args: unknown[]): Promise<T> {
    // SAFETY: libsql 返回的 Row 列已是 JS 原始类型（number/string/null），与各查询的契约行一一对应；
    // 调用点按查询用具体行类型（any[] + map/Number 归一）收口，T 仅为免重复声明的泛型。
    const r = await this.c.execute({ sql, args: args as any[] });
    return r.rows as unknown as T;
  }
  private async exec(sql: string, args: unknown[] = []): Promise<void> { await this.c.execute({ sql, args: args as any[] }); }

  async sendMessageAndEvent(m: MessageInput): Promise<{ messageId: number; eventId: number }> {
    const tx = await this.c.transaction("write"); // @libsql/client：BEGIN IMMEDIATE（execute 逐条自动提交，须用事务对象）
    try {
      const ins = await tx.execute({ sql: SQL.insMessage, args: [m.client_id, m.nick, m.text, m.created_at] });
      const messageId = Number(ins.lastInsertRowid);
      const payload = JSON.stringify({ id: String(messageId), client_id: m.client_id, nick: m.nick, text: m.text, created_at: m.created_at });
      const ev = await tx.execute({ sql: SQL.insEvent, args: ["message", payload, m.created_at] });
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
      const ev = await tx.execute({ sql: SQL.insEvent, args: ["message", "", m.created_at] });
      const eventId = Number(ev.lastInsertRowid);
      const payload = JSON.stringify({ id: `e${eventId}`, client_id: m.client_id, nick: m.nick, text: m.text, created_at: m.created_at });
      await tx.execute({ sql: "UPDATE events SET payload = ? WHERE id = ?", args: [payload, eventId] });
      await tx.commit();
      return { eventId };
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
  }
  async insertEvent(type: string, payload: string, created_at: number): Promise<number> {
    const r = await this.c.execute({ sql: SQL.insEvent, args: [type, payload, created_at] });
    return Number(r.lastInsertRowid);
  }
  async eventsSince(since: number, limit: number): Promise<EventRow[]> { return this.run<any[]>(SQL.eventsSince, [since, limit]); }
  async eventsMaxId(): Promise<number> { const r = await this.run<any[]>(SQL.maxEventId, []); return Number(r[0]?.m ?? 0); }
  async historyBefore(before: number, limit: number): Promise<MessageRow[]> { return (await this.run<any[]>(SQL.before, [before, limit])).map(mapMessage); }
  async historySince(since: number, limit: number): Promise<MessageRow[]> { return (await this.run<any[]>(SQL.since, [since, limit])).map(mapMessage); }
  async softDeleteMessage(id: number, by: string, at: number): Promise<boolean> { const r = await this.c.execute({ sql: SQL.softDel, args: [at, by, id] }); return Number(r.rowsAffected) > 0; }
  /** true = 新建封禁；false = 该 IP 已在封禁名单（本次覆盖更新）。libsql/sqlite 的 UPSERT rowsAffected 恒为 1（实证），
   * 无法区分分支 → 写事务（BEGIN IMMEDIATE）内存在性检查判定，原子。 */
  async banUpsert(ip: string, reason: string, by: string, at: number): Promise<boolean> {
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
  async banGet(ip: string): Promise<{ reason: string; created_at: number } | null> {
    const r = await this.run<any[]>(SQL.banGet, [ip]);
    return r[0] ? { reason: r[0].reason, created_at: Number(r[0].created_at) } : null;
  }
  async banList(limit: number, offset: number): Promise<BanRow[]> {
    return this.run<any[]>(SQL.banList, [limit, offset]).then(rs => rs.map(r => ({ ip: r.ip, reason: r.reason, created_at: Number(r.created_at) })));
  }
  async banRemove(ip: string): Promise<boolean> { const r = await this.c.execute({ sql: SQL.banDel, args: [ip] }); return Number(r.rowsAffected) > 0; }
  async presenceUpsert(clientId: string, at: number): Promise<void> { await this.exec(SQL.presUp, [clientId, at]); }
  async presenceCount(cutoff: number): Promise<number> { const r = await this.run<any[]>(SQL.presCnt, [cutoff]); return Number(r[0]?.c ?? 0); }
  async rateHit(bucket: string, scope: string, windowStart: number): Promise<number> { const r = await this.run<any[]>(SQL.rateHit, [bucket, scope, windowStart]); return Number(r[0]?.count ?? 1); }
  async messageStats(): Promise<{ total: number; retained: number }> {
    // 口径 = 物理行（含软删占位）；软删不改行数，仅保留裁剪物理删除 → total/retained 恒等，双字段仅为语义区分
    const r = await this.run<any[]>(SQL.stats, []);
    const total = Number(r[0]?.total ?? 0);
    return { total, retained: total };
  }
  async cleanupEvents(before: number): Promise<number> { return this.affected(SQL.delEvents, [before]); }
  async cleanupPresence(before: number): Promise<number> { return this.affected(SQL.delPres, [before]); }
  async cleanupRateLimits(before: number): Promise<number> { return this.affected(SQL.delRates, [before]); }
  async trimMessagesBelow(idFloor: number): Promise<number> { return this.affected(SQL.trimBelow, [idFloor]); }
  async deleteMessagesOlderThan(cutoff: number): Promise<number> { return this.affected(SQL.delOlder, [cutoff]); }
  private async affected(sql: string, args: unknown[]): Promise<number> { const r = await this.c.execute({ sql, args: args as any[] }); return Number(r.rowsAffected); }
}

class PostgresRepo implements Repo {
  readonly provider = "postgres" as const;
  constructor(private sql: postgres.Sql<{}>) {}
  async bootstrap(): Promise<void> { for (const d of ddlFor("postgres")) await this.sql.unsafe(d); }
  async close(): Promise<void> { await this.sql.end(); }
  private toPgParams(sql: string, args: unknown[]) {
    let i = 0;
    const converted = sql.replace(/\?/g, () => `$${++i}`);
    return { sql: converted, args };
  }
  private async query<T>(sql: string, args: unknown[]): Promise<T[]> {
    const { sql: s, args: a } = this.toPgParams(sql, args);
    // SAFETY: postgres.js unsafe 返回 RowList（含 count 元数据、按列解出的 JS 值），此处仅做泛型收口；
    // 具体列契约由各查询调用点的行类型（T 为行类型，如 any / { id: number }）保证。
    return (await this.sql.unsafe(s, a as any[])) as unknown as T[];
  }
  private async exec(sql: string, args: unknown[]): Promise<void> {
    const { sql: s, args: a } = this.toPgParams(sql, args);
    await this.sql.unsafe(s, a as any[]);
  }
  private async countAffected(sql: string, args: unknown[]): Promise<number> {
    const { sql: s, args: a } = this.toPgParams(sql, args);
    const r = await this.sql.unsafe(s, a as any[]);
    return r.count === undefined ? 0 : Number(r.count);
  }
  async sendMessageAndEvent(m: MessageInput): Promise<{ messageId: number; eventId: number }> {
    return await this.sql.begin(async tx => {
      const [msg] = await tx.unsafe(`INSERT INTO messages (client_id, nick, text, created_at) VALUES ($1, $2, $3, $4) RETURNING id`, [m.client_id, m.nick, m.text, m.created_at]);
      const messageId = Number(msg.id);
      const payload = JSON.stringify({ id: String(messageId), client_id: m.client_id, nick: m.nick, text: m.text, created_at: m.created_at });
      const [ev] = await tx.unsafe(`INSERT INTO events (type, payload, created_at) VALUES ($1, $2, $3) RETURNING id`, ["message", payload, m.created_at]);
      return { messageId, eventId: Number(ev.id) };
    });
  }

  async publishEphemeralMessage(m: MessageInput): Promise<{ eventId: number }> {
    return await this.sql.begin(async tx => {
      const [ev] = await tx.unsafe(`INSERT INTO events (type, payload, created_at) VALUES ($1, $2, $3) RETURNING id`, ["message", "", m.created_at]);
      const eventId = Number(ev.id);
      const payload = JSON.stringify({ id: `e${eventId}`, client_id: m.client_id, nick: m.nick, text: m.text, created_at: m.created_at });
      await tx.unsafe(`UPDATE events SET payload = $1 WHERE id = $2`, [payload, eventId]);
      return { eventId };
    });
  }
  async insertEvent(type: string, payload: string, created_at: number): Promise<number> {
    const r = await this.query<{ id: number }>(SQL.insEvent + " RETURNING id", [type, payload, created_at]);
    return Number(r[0]?.id ?? 0);
  }
  async eventsSince(since: number, limit: number): Promise<EventRow[]> { return await this.query<EventRow>(SQL.eventsSince, [since, limit]); }
  async eventsMaxId(): Promise<number> { const r = await this.query<{ m: number | string }>(SQL.maxEventId, []); return Number(r[0]?.m ?? 0); }
  async historyBefore(before: number, limit: number): Promise<MessageRow[]> { return (await this.query<any>(SQL.before, [before, limit])).map(mapMessage); }
  async historySince(since: number, limit: number): Promise<MessageRow[]> { return (await this.query<any>(SQL.since, [since, limit])).map(mapMessage); }
  async softDeleteMessage(id: number, by: string, at: number): Promise<boolean> { return (await this.countAffected(SQL.softDel, [at, by, id])) > 0; }
  /** true = 新建封禁；false = 已存在（本次覆盖更新）。RETURNING (xmax = 0) 区分分支。 */
  async banUpsert(ip: string, reason: string, by: string, at: number): Promise<boolean> {
    const r = await this.query<{ inserted: boolean }>(banUpsertPg, [ip, reason, by, at]);
    return r[0]?.inserted === true;
  }
  async banGet(ip: string): Promise<{ reason: string; created_at: number } | null> {
    const r = await this.query<any>(SQL.banGet, [ip]);
    return r[0] ? { reason: r[0].reason, created_at: Number(r[0].created_at) } : null;
  }
  async banList(limit: number, offset: number): Promise<BanRow[]> {
    return (await this.query<any>(SQL.banList, [limit, offset])).map(r => ({ ip: r.ip, reason: r.reason, created_at: Number(r.created_at) }));
  }
  async banRemove(ip: string): Promise<boolean> { return (await this.countAffected(SQL.banDel, [ip])) > 0; }
  async presenceUpsert(clientId: string, at: number): Promise<void> { await this.exec(SQL.presUp, [clientId, at]); }
  async presenceCount(cutoff: number): Promise<number> { const r = await this.query<{ c: number | string }>(SQL.presCnt, [cutoff]); return Number(r[0]?.c ?? 0); }
  async rateHit(bucket: string, scope: string, windowStart: number): Promise<number> { const r = await this.query<{ count: number | string }>(SQL.rateHit, [bucket, scope, windowStart]); return Number(r[0]?.count ?? 1); }
  async messageStats(): Promise<{ total: number; retained: number }> {
    // 口径同 sqlite：物理行（含软删占位），total/retained 恒等
    const r = await this.query<{ total: number | string }>(SQL.stats, []);
    const total = Number(r[0]?.total ?? 0);
    return { total, retained: total };
  }
  async cleanupEvents(before: number): Promise<number> { return this.countAffected(SQL.delEvents, [before]); }
  async cleanupPresence(before: number): Promise<number> { return this.countAffected(SQL.delPres, [before]); }
  async cleanupRateLimits(before: number): Promise<number> { return this.countAffected(SQL.delRates, [before]); }
  async trimMessagesBelow(idFloor: number): Promise<number> { return this.countAffected(SQL.trimBelow, [idFloor]); }
  async deleteMessagesOlderThan(cutoff: number): Promise<number> { return this.countAffected(SQL.delOlder, [cutoff]); }
}

export async function createRepo(provider: Provider, databaseUrl: string, authToken?: string): Promise<Repo> {
  if (provider === "sqlite") {
    return new SqliteRepo(createClient({ url: databaseUrl, authToken }));
  }
  const ssl = /[?&]sslmode=require/.test(databaseUrl) ? "require" : false;
  return new PostgresRepo(postgres(databaseUrl, { ssl, max: 1 }));
}
