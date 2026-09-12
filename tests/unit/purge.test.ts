import { describe, expect, test } from "bun:test";
import {
  PURGE_PHRASES,
  PURGE_TABLES,
  PURGE_TOKEN_TTL_MS,
  isPurgeScope,
  mintPurgeToken,
  purgePhraseMatches,
  verifyPurgeToken,
} from "../../src/lib/purge";

const SECRET = "unit-secret";
const IP = "9.9.9.9";

describe("purge 校验核心（危险操作的多重校验）", () => {
  test("isPurgeScope 只接受 chat / full", () => {
    expect(isPurgeScope("chat")).toBe(true);
    expect(isPurgeScope("full")).toBe(true);
    for (const bad of [
      "all",
      "messages",
      "",
      "CHAT",
      1,
      null,
      undefined,
      {},
      ["chat"],
    ])
      expect(isPurgeScope(bad)).toBe(false);
  });

  test("确认短语两档不同，必须逐字匹配（仅容忍首尾空白）", () => {
    expect(PURGE_PHRASES.chat).toBe("清空聊天记录");
    expect(PURGE_PHRASES.full).toBe("清空全部数据");
    expect(purgePhraseMatches("chat", "清空聊天记录")).toBe(true);
    expect(purgePhraseMatches("chat", "  清空聊天记录\n")).toBe(true);
    expect(purgePhraseMatches("full", "清空全部数据")).toBe(true);
    expect(purgePhraseMatches("chat", "清空全部数据")).toBe(false);
    expect(purgePhraseMatches("chat", "清空聊天")).toBe(false);
    expect(purgePhraseMatches("chat", "清空聊天記录")).toBe(false);
    expect(purgePhraseMatches("chat", undefined)).toBe(false);
    expect(purgePhraseMatches("chat", 123)).toBe(false);
  });

  test("档位 → 涉及表：chat 只碰消息与事件，full 覆盖五张表", () => {
    expect([...PURGE_TABLES.chat]).toEqual(["messages", "events"]);
    expect([...PURGE_TABLES.full]).toEqual([
      "messages",
      "events",
      "presence",
      "rate_limits",
      "bans",
    ]);
  });

  test("令牌：签发后可校验，回带同一 nonce 与过期时间", () => {
    const now = Date.now();
    const minted = mintPurgeToken({ scope: "chat", ip: IP }, SECRET, now);
    expect(minted.expiresAt).toBe(now + PURGE_TOKEN_TTL_MS);
    expect(minted.nonce.length).toBeGreaterThanOrEqual(32);
    const v = verifyPurgeToken(minted.token, { scope: "chat", ip: IP }, SECRET);
    expect(v.ok).toBe(true);
    expect(v.ok && v.nonce).toBe(minted.nonce);
  });

  test("令牌：档位不符 / IP 不符 / 篡改 / 过期 / 换密钥 一律拒绝", () => {
    const { token } = mintPurgeToken({ scope: "chat", ip: IP }, SECRET);
    expect(verifyPurgeToken(token, { scope: "full", ip: IP }, SECRET)).toEqual({
      ok: false,
      reason: "token_scope",
    });
    expect(
      verifyPurgeToken(token, { scope: "chat", ip: "1.1.1.1" }, SECRET),
    ).toEqual({ ok: false, reason: "token_ip" });
    expect(
      verifyPurgeToken(`${token}x`, { scope: "chat", ip: IP }, SECRET).ok,
    ).toBe(false);
    expect(
      verifyPurgeToken(undefined, { scope: "chat", ip: IP }, SECRET).ok,
    ).toBe(false);
    expect(
      verifyPurgeToken("abc.def", { scope: "chat", ip: IP }, SECRET).ok,
    ).toBe(false);
    expect(
      verifyPurgeToken(token, { scope: "chat", ip: IP }, "other-secret").ok,
    ).toBe(false);
    // Expired: minted before the TTL window, so the exp check rejects it.
    const stale = mintPurgeToken(
      { scope: "chat", ip: IP },
      SECRET,
      Date.now() - PURGE_TOKEN_TTL_MS - 1,
    );
    expect(
      verifyPurgeToken(stale.token, { scope: "chat", ip: IP }, SECRET),
    ).toEqual({ ok: false, reason: "invalid_token" });
  });

  test("令牌不可预测：两次签发 nonce 与令牌均不同", () => {
    const a = mintPurgeToken({ scope: "full", ip: IP }, SECRET);
    const b = mintPurgeToken({ scope: "full", ip: IP }, SECRET);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.token).not.toBe(b.token);
  });
});
