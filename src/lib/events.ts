import type { HistoryMode } from "./history";
import type { MessageInput } from "./repo";

/**
 * 出站事件载荷的唯一形状来源。
 * 三个方言 adapter 与 app.ts 的 notice 都从这里取，契约变更只改一处；
 * 客户端解析的就是这些字段名，分散拼装时最容易在某一条路径上漂移。
 */
export interface MessageEventPayload {
  id: string;
  client_id: string;
  nick: string;
  text: string;
  created_at: number;
}

/** messages.id 是数字，ephemeral 的 id 是字符串：统一成字符串，避免客户端出现两种类型。 */
export function messageEventPayload(
  m: MessageInput,
  id: number | string,
): MessageEventPayload {
  return {
    id: String(id),
    client_id: m.client_id,
    nick: m.nick,
    text: m.text,
    created_at: m.created_at,
  };
}

/** ephemeral 消息不进 messages 表：e+uuid 避免与 messages.id 空间混淆。 */
export function ephemeralMessageId(): string {
  return `e${crypto.randomUUID()}`;
}

/** 只带 id：删掉的正文不能再通过事件流回放出去。 */
export function deleteEventPayload(id: number | string): { id: string } {
  return { id: String(id) };
}

export interface HistoryNoticePayload {
  kind: "history_mode";
  mode: HistoryMode;
  retention_days: number;
}

export function historyNoticePayload(
  mode: HistoryMode,
  retentionDays: number,
): HistoryNoticePayload {
  return { kind: "history_mode", mode, retention_days: retentionDays };
}
