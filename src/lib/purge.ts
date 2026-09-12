import { COPY } from "./copy";
import { signToken, verifyToken } from "./security";

/** Purge core: scope allowlist, exact confirm phrase, single-use token (pure, no IO). */

export type PurgeScope = "chat" | "full";

/** Keys match table names, so the API layer needs no mapping. */
export interface PurgeCounts {
 messages: number;
 events: number;
 presence: number;
 rate_limits: number;
 bans: number;
}

/** Purgeable table = count key, so the two can never drift. */
export type PurgeTable = keyof PurgeCounts;

export const PURGE_ALL_TABLES: readonly PurgeTable[] = [
 "messages",
 "events",
 "presence",
 "rate_limits",
 "bans",
];

/** Scope → tables allowlist; callers can never name arbitrary tables. */
export const PURGE_TABLES: Record<PurgeScope, readonly PurgeTable[]> = {
 chat: ["messages", "events"],
 full: ["messages", "events", "presence", "rate_limits", "bans"],
};

export const PURGE_PHRASES: Record<PurgeScope, string> = {
 chat: COPY.purge.phraseChat,
 full: COPY.purge.phraseFull,
};

export const PURGE_SCOPE_DESC: Record<PurgeScope, string> = {
 chat: COPY.purge.descChat,
 full: COPY.purge.descFull,
};

export const PURGE_TOKEN_TTL_MS = 60_000;

export function isPurgeScope(v: unknown): v is PurgeScope {
 return v === "chat" || v === "full";
}

/** Only leading/trailing whitespace is tolerated (mobile keyboards add it); inner diffs fail. */
export function purgePhraseMatches(scope: PurgeScope, input: unknown): boolean {
 return typeof input === "string" && input.trim() === PURGE_PHRASES[scope];
}

export type PurgeTokenReason = "invalid_token" | "token_scope" | "token_ip";

export type PurgeTokenVerdict =
 | { ok: true; nonce: string }
 | { ok: false; reason: PurgeTokenReason };

/** The token binds scope + requester IP; the nonce backs the single-use check. */
export function mintPurgeToken(
 o: { scope: PurgeScope; ip: string },
 secret: string,
 now: number = Date.now(),
): { token: string; expiresAt: number; nonce: string } {
 const nonce = crypto.randomUUID().replace(/-/g, "");
 const expiresAt = now + PURGE_TOKEN_TTL_MS;
 const token = signToken(
  { sub: "purge", scope: o.scope, ip: o.ip, nonce, exp: expiresAt },
  secret,
 );
 return { token, expiresAt, nonce };
}

/** Expired and tampered tokens both report invalid_token, so probing reveals nothing extra. */
export function verifyPurgeToken(
 token: string | undefined,
 o: { scope: PurgeScope; ip: string },
 secret: string,
): PurgeTokenVerdict {
 const p = verifyToken(token, secret);
 if (!p || p.sub !== "purge" || typeof p.nonce !== "string")
  return { ok: false, reason: "invalid_token" };
 if (p.scope !== o.scope) return { ok: false, reason: "token_scope" };
 if (p.ip !== o.ip) return { ok: false, reason: "token_ip" };
 return { ok: true, nonce: p.nonce };
}
