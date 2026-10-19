import { describe, expect, test } from "bun:test";
import {
  deleteEventPayload,
  ephemeralMessageId,
  historyNoticePayload,
  messageEventPayload,
} from "../../src/lib/events";

describe("事件载荷", () => {
  test("message：id 为字符串，字段与契约一致", () => {
    expect(
      messageEventPayload(
        { client_id: "c", nick: "n", text: "t", created_at: 7 },
        42,
      ),
    ).toEqual({
      id: "42",
      client_id: "c",
      nick: "n",
      text: "t",
      created_at: 7,
    });
  });
  test("ephemeral：id 带 e 前缀且不落 messages 命名空间", () => {
    const id = ephemeralMessageId();
    expect(id).toMatch(/^e[0-9a-f-]{36}$/);
  });
  test("delete：只带 id，不泄露正文", () => {
    expect(deleteEventPayload(42)).toEqual({ id: "42" });
  });
  test("notice：history_mode 的字段名与客户端约定一致", () => {
    expect(historyNoticePayload("ephemeral", 1)).toEqual({
      kind: "history_mode",
      mode: "ephemeral",
      retention_days: 1,
    });
  });
});
