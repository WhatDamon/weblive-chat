import { buildWordFilter, type WordFilter } from "./wordfilter";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validUuid = (s: string) => UUID_RE.test(s);

export function sanitizeText(s: string): string {
  // Strips control chars; newlines cannot survive SSE data lines anyway.
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
    return { ok: false, code: "invalid_uuid", field: "client_id" };
  const nick = typeof b.nick === "string" ? sanitizeText(b.nick) : "";
  const text = typeof b.text === "string" ? sanitizeText(b.text) : "";
  if (!nick)
    return { ok: false, code: "nick_empty", field: "nick" };
  if (nick.length > cfg.nickMax)
    return { ok: false, code: "nick_too_long", field: "nick" };
  if (!text)
    return { ok: false, code: "text_empty", field: "text" };
  if (text.length > cfg.textMax)
    return { ok: false, code: "text_too_long", field: "text" };
  const matcher = cfg.filter ?? matcherFor(cfg.bannedWords);
  const textHit = matcher.scan(text) ? ("text" as const) : null;
  const hit = textHit ?? (matcher.scan(nick) ? ("nick" as const) : null);
  if (hit)
    return { ok: false, code: "banned_word", field: hit };
  return { ok: true, nick, text };
}

// Fallback matcher used when no filter is injected (tests, direct calls); cached per word list.
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
