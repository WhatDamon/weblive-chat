import { buildWordFilter, type WordFilter } from "./wordfilter";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validUuid = (s: string) => UUID_RE.test(s);

export function sanitizeText(s: string): string {
  // 剥离控制字符（保留常见可见文本；SSE 的 \n 会被事件 data 行语义化，前端自处理）
  return s.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

export type MsgErr =
  | {
      ok: false;
      code:
        | "invalid_uuid"
        | "nick_empty"
        | "nick_too_long"
        | "text_empty"
        | "text_too_long"
        | "banned_word";
      field: string;
      message: string;
    }
  | { ok: true; nick: string; text: string };

export function validateMessageBody(
  cfg: {
    nickMax: number;
    textMax: number;
    bannedWords: string[];
    filter?: WordFilter;
  },
  body: unknown,
): MsgErr {
  const b = (body ?? {}) as Record<string, unknown>;
  const client_id = typeof b.client_id === "string" ? b.client_id : "";
  if (!validUuid(client_id))
    return {
      ok: false,
      code: "invalid_uuid",
      field: "client_id",
      message: "client_id 必须是合法 UUID",
    };
  const nick = typeof b.nick === "string" ? sanitizeText(b.nick) : "";
  const text = typeof b.text === "string" ? sanitizeText(b.text) : "";
  if (!nick)
    return {
      ok: false,
      code: "nick_empty",
      field: "nick",
      message: "昵称不能为空",
    };
  if (nick.length > cfg.nickMax)
    return {
      ok: false,
      code: "nick_too_long",
      field: "nick",
      message: `昵称最长 ${cfg.nickMax} 字`,
    };
  if (!text)
    return {
      ok: false,
      code: "text_empty",
      field: "text",
      message: "内容不能为空",
    };
  if (text.length > cfg.textMax)
    return {
      ok: false,
      code: "text_too_long",
      field: "text",
      message: `内容最长 ${cfg.textMax} 字`,
    };
  const matcher = cfg.filter ?? matcherFor(cfg.bannedWords);
  const textHit = matcher.scan(text) ? ("text" as const) : null;
  const hit = textHit ?? (matcher.scan(nick) ? ("nick" as const) : null);
  if (hit)
    return {
      ok: false,
      code: "banned_word",
      field: hit,
      message: "内容含违禁词",
    };
  return { ok: true, nick, text };
}

// 未注入词库（单测/直接调用）时按显式词表即时建树，并按词表内容缓存复用
const matcherCache = new Map<string, WordFilter>();
function matcherFor(words: readonly string[]): WordFilter {
  const key = words.join("\u0000");
  let m = matcherCache.get(key);
  if (!m) {
    m = buildWordFilter(words);
    matcherCache.set(key, m);
  }
  return m;
}
