import { createHmac, timingSafeEqual } from "node:crypto";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
// Accepts IPv4-mapped IPv6 (::ffff:1.2.3.4, common in XFF); matching only needs symmetry.
const IPV6 = /^[0-9a-f:.]+$/i;

export function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (
    !v ||
    (v.includes(":") && !IPV6.test(v)) ||
    (!v.includes(":") && !IPV4.test(v))
  )
    return null;
  return v.includes(":") ? v.toLowerCase() : v;
}

export function clientIpFromHeaders(
  headers: Record<string, string | undefined>,
  fallback: string,
): string {
  const xff = headers["x-forwarded-for"];
  if (xff) {
    for (const part of xff.split(",")) {
      const ip = normalizeIp(part);
      if (ip) return ip;
    }
  }
  return normalizeIp(fallback) ?? "0.0.0.0";
}

export function normalizeOrigin(o: string): string {
  return o.trim().toLowerCase().replace(/\/+$/, "");
}

// "*.example.com" (optional scheme and port) means the domain and all of its subdomains.
const WILDCARD = /^(?:([a-z][a-z0-9+.-]*):\/\/)?\*\.([^/:*]+)(?::(\d{1,5}))?$/;

interface Wildcard {
  scheme?: string;
  base: string;
  port?: string;
}

function parseWildcard(pattern: string): Wildcard | null {
  const m = WILDCARD.exec(pattern);
  if (!m) return null;
  const raw = m[2].replace(/\.+$/, ""); // tolerate a trailing root dot
  if (!raw) return null;
  try {
    // Hostname lookup punycodes IDN and rejects syntactically impossible hosts.
    const base = new URL(`http://${raw}`).hostname;
    if (!base) return null;
    return { scheme: m[1] ? `${m[1]}://` : undefined, base, port: m[3] };
  } catch {
    return null;
  }
}

/** Exact entries match verbatim; `*`-bearing entries must be valid wildcard patterns. */
function matchOrigin(pattern: string, origin: string): boolean {
  if (!pattern.includes("*")) return pattern === origin;
  const w = parseWildcard(pattern);
  if (!w) return false; // invalid patterns never match (config load rejects them)
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (w.scheme && `${u.protocol}//` !== w.scheme) return false;
  // A pattern without a port accepts only default ports (u.port is "" for those).
  if (w.port ? u.port !== w.port : u.port !== "") return false;
  const host = u.hostname.toLowerCase();
  return host === w.base || host.endsWith(`.${w.base}`);
}

export function parseOriginList(v: string | undefined): string[] {
  const list: string[] = [];
  for (const entry of (v ?? "").split(",").map(normalizeOrigin)) {
    if (!entry) continue;
    if (entry !== "*" && entry.includes("*") && !parseWildcard(entry))
      throw new Error(
        `ALLOWED_ORIGINS entry "${entry}" is not a valid pattern: use https://host, *.example.com or *`,
      );
    list.push(entry);
  }
  return list;
}
export type OriginClass =
  | { mode: "open" }
  | { mode: "allowed"; origin: string }
  | { mode: "no_origin" }
  | { mode: "denied"; code: "origin_not_allowed" | "missing_origin" };
export function classifyOrigin(
  origin: string | undefined,
  allowed: string[],
  requireOrigin: boolean,
): OriginClass {
  if (allowed.length === 0) return { mode: "open" };
  if (!origin)
    return requireOrigin
      ? { mode: "denied", code: "missing_origin" }
      : { mode: "no_origin" };
  const o = normalizeOrigin(origin);
  return allowed.some((p) => matchOrigin(p, o))
    ? { mode: "allowed", origin: o }
    : { mode: "denied", code: "origin_not_allowed" };
}

const b64url = (buf: Buffer) => buf.toString("base64url");
const sha = (secret: string, data: string) =>
  createHmac("sha256", secret).update(data).digest();

export function signToken(
  payload: Record<string, unknown>,
  secret: string,
): string {
  const data = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${data}.${b64url(sha(secret, data))}`;
}
export function verifyToken(
  token: string | undefined,
  secret: string,
): Record<string, unknown> | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const expected = sha(secret, data);
    const got = Buffer.from(sig, "base64url");
    if (got.length !== expected.length || !timingSafeEqual(got, expected))
      return null;
    const payload = JSON.parse(
      Buffer.from(data, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const exp = Number(payload.exp ?? 0);
    if (!exp || exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
