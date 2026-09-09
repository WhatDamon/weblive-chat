import { describe, expect, test } from "bun:test";
import { sanitizeText, validUuid, validateMessageBody } from "../../src/lib/validate";

const cfg = { nickMax: 24, textMax: 1000, bannedWords: ["赌博", "spam"] };

type MsgCode = "invalid_uuid" | "nick_empty" | "nick_too_long" | "text_empty" | "text_too_long" | "banned_word";

function expectCode(body: unknown, code: MsgCode) {
  const r = validateMessageBody(cfg, body);
  if (r.ok) throw new Error(`expected validation failure, got ok: ${JSON.stringify(r)}`);
  expect(r.code).toBe(code);
}

describe("validateMessageBody", () => {
  test("合法消息通过；返回清洗后字段", () => {
    expect(validateMessageBody(cfg, { client_id: "11111111-2222-4333-8444-555555555555", nick: " 甲 ", text: "你好世界" })).toEqual({ ok: true, nick: "甲", text: "你好世界" });
  });
  test("uuid 非法 / 昵称超长 / 文本超长 / 禁词（子串）各自失败", () => {
    expectCode({ client_id: "nope", nick: "甲", text: "hi" }, "invalid_uuid");
    expectCode({ client_id: "11111111-2222-4333-8444-555555555555", nick: "x".repeat(25), text: "hi" }, "nick_too_long");
    expectCode({ client_id: "11111111-2222-4333-8444-555555555555", nick: "甲", text: "x".repeat(1001) }, "text_too_long");
    expectCode({ client_id: "11111111-2222-4333-8444-555555555555", nick: "甲", text: "阳光大赌博场" }, "banned_word");
    expectCode({ client_id: "11111111-2222-4333-8444-555555555555", nick: "", text: "hi" }, "nick_empty");
    expectCode({ client_id: "11111111-2222-4333-8444-555555555555", nick: "甲", text: "  " }, "text_empty");
  });
  test("sanitizeText 剥离控制字符；validUuid 大小写不敏感", () => {
    expect(sanitizeText("a\u0000b\u0007c")).toBe("abc");
    expect(validUuid("11111111-2222-4333-8444-555555555555")).toBe(true);
    expect(validUuid("11111111-2222-4333-8444-55555555555Z")).toBe(false);
  });
});
