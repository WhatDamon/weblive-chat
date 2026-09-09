import { createHmac, timingSafeEqual } from "node:crypto";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
// 允许 IPv4-mapped IPv6（如 ::ffff:1.2.3.4，XFF 常见形态）：含冒号时放行 0-9a-f 与点，仅做小写/trim 归一（匹配对称即可）
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
export function parseOriginList(v: string | undefined): string[] {
  return (v ?? "").split(",").map(normalizeOrigin).filter(Boolean);
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
  return allowed.includes(o)
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
