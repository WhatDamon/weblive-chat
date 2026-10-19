import type { RateSink } from "./limits";
import type { PurgeCounts, PurgeScope } from "./purge";
import type { BanRow, EventRow, MessageInput, MessageRow } from "./repo";

/**
 * 路由能依赖的最小能力集合。
 * 传全量 Repo 也能用，但把宽度写进类型后，改某个能力时编译器会指出所有受影响的路由，
 * 测试也能用 5 个方法拼出流循环的替身，不必伪造 25 个方法。
 * 这些是 type-only import：编译后擦除，不会与 repo.ts 形成运行时循环依赖。
 */

export interface MessageStore {
  historyBefore(before: number, limit: number): Promise<MessageRow[]>;
  historySince(since: number, limit: number): Promise<MessageRow[]>;
  /** 第 offset 新的消息 id（0 起，id 倒序），越界返回 null。 */
  idAtOffset(offset: number): Promise<number | null>;
  /** 单事务：软删成功才写 delete 事件；重复删返回 false 且不重复广播。 */
  softDeleteMessageAndEvent(
    id: number,
    by: string,
    at: number,
  ): Promise<boolean>;
}

export interface EventOutbox {
  insertEvent(
    type: string,
    payload: string,
    created_at: number,
  ): Promise<number>;
  eventsSince(since: number, limit: number): Promise<EventRow[]>;
  eventsMaxId(): Promise<number>;
  sendMessageAndEvent(
    m: MessageInput,
  ): Promise<{ messageId: number; eventId: number }>;
  publishEphemeralMessage(m: MessageInput): Promise<{ messageId: string }>;
}

export interface PresenceStore {
  presenceUpsert(clientId: string, at: number): Promise<void>;
  presenceCount(cutoff: number): Promise<number>;
}

export interface BanStore {
  banUpsert(
    ip: string,
    reason: string,
    by: string,
    at: number,
  ): Promise<boolean>;
  banGet(ip: string): Promise<{ reason: string; created_at: number } | null>;
  banList(limit: number, offset: number): Promise<BanRow[]>;
  banRemove(ip: string): Promise<boolean>;
}

export interface PurgeStore {
  /** Purge preview: read-only per-table row counts. */
  purgeCounts(): Promise<PurgeCounts>;
  /** Purges only PURGE_TABLES[scope]; returns actually deleted row counts. */
  clearData(scope: PurgeScope): Promise<PurgeCounts>;
}

export interface MaintenanceStore {
  /** Cheapest liveness probe: SELECT 1. */
  ping(): Promise<void>;
  /** 运维探针：已应用的 schema 版本 + 关键索引名（health 与测试共用）。 */
  schemaInfo(): Promise<{ version: number; indexes: string[] }>;
  /** Physical row count incl. soft-deleted rows; capacity and degrade decisions must use this. */
  messageStats(): Promise<{ total: number; retained: number }>;
  cleanupEvents(before: number): Promise<number>;
  cleanupPresence(before: number): Promise<number>;
  cleanupRateLimits(before: number): Promise<number>;
  trimMessagesBelow(idFloor: number): Promise<number>;
  deleteMessagesOlderThan(cutoff: number): Promise<number>;
}

/** 聊天路由：读历史、写消息、在线数、封禁、限流。 */
export type ChatRepo = MessageStore &
  EventOutbox &
  PresenceStore &
  BanStore &
  RateSink;

/** 管理后台：封禁、消息、清空、维护、在线数、限流。 */
export type AdminRepo = BanStore &
  MessageStore &
  PurgeStore &
  MaintenanceStore &
  PresenceStore &
  RateSink;
