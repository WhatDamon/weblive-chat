import type { BannedWordsMode } from "./wordfilter";

export type Provider = "sqlite" | "postgres" | "memory";

export interface RateCfg {
  msgPerMin: number;
  streamPerMin: number;
  loginPerMin: number;
  /** Preview and execute share this bucket. */
  purgePerMin: number;
  windowMs: number;
}

export interface AppConfig {
  env: string;
  port: number;
  dbProvider: Provider;
  databaseUrl: string;
  tursoAuthToken?: string;
  migrateOnBoot: boolean;
  adminSecret: string;
  devIp: string; // fallback when x-forwarded-for is absent (local dev, no proxy)
  nickMax: number;
  textMax: number;
  // bannedWords = explicit extras; the rest load from bannedWordsDir per mode
  bannedWords: string[];
  bannedWordsMode: BannedWordsMode;
  bannedWordsDir: string;
  bannedWordsAllow: string[];
  retentionDays: number;
  maxRows: number;
  backfillMax: number;
  presenceTtlMs: number;
  pollMs: number;
  presenceUpsertMs: number;
  presenceCountMs: number;
  heartbeatMs: number;
  eventsTtlMs: number;
  maintenanceEvery: number;
  rate: RateCfg;
  allowedOrigins: string[];
  requireOrigin: boolean;
  sessionDays: number;
  cookieName: string;
}

const envInt = (
  env: Record<string, string | undefined>,
  key: string,
  def: number,
): number => {
  const v = env[key];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0)
    throw new Error(`Env ${key} must be a non-negative number, got "${v}"`);
  return Math.floor(n);
};

export function loadConfig(
  env: Record<string, string | undefined> = {},
): AppConfig {
  const provider = env.DB_PROVIDER ?? "sqlite";
  if (provider !== "sqlite" && provider !== "postgres" && provider !== "memory")
    throw new Error(
      `DB_PROVIDER must be sqlite|postgres|memory, got "${provider}"`,
    );
  const databaseUrl =
    env.DATABASE_URL ?? (provider === "sqlite" ? "file:./data/dev.db" : "");
  if (provider === "postgres" && !/^postgres(ql)?:\/\//.test(databaseUrl))
    throw new Error("DB_PROVIDER=postgres requires DATABASE_URL");
  const envName = env.NODE_ENV ?? "development";
  // memory has no persistence and no cross-instance sharing, so serverless cannot use it.
  if (provider === "memory" && envName === "production")
    throw new Error(
      "DB_PROVIDER=memory cannot run in production/Vercel (no persistence, no shared memory); use sqlite(Turso) or postgres",
    );
  const adminSecret = env.ADMIN_SECRET ?? "";
  if (envName === "production" && !adminSecret)
    throw new Error("ADMIN_SECRET is required in production");
  // Empty = open mode; "*" also means open, since treating it literally locks out every origin.
  const rawOrigins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/\/+$/, ""))
    .filter(Boolean);
  const allowedOrigins = rawOrigins.includes("*") ? [] : rawOrigins;
  const bannedWordsMode = env.BANNED_WORDS_MODE ?? "basic";
  if (
    bannedWordsMode !== "off" &&
    bannedWordsMode !== "basic" &&
    bannedWordsMode !== "strict"
  )
    throw new Error(
      `BANNED_WORDS_MODE must be off|basic|strict, got "${bannedWordsMode}"`,
    );
  const rateWindowMs = 60_000;
  return {
    env: envName,
    port: envInt(env, "PORT", 3000),
    dbProvider: provider,
    databaseUrl,
    tursoAuthToken: env.TURSO_AUTH_TOKEN,
    migrateOnBoot: (env.DB_MIGRATE_ON_BOOT ?? "true") !== "false",
    adminSecret: adminSecret || "dev-insecure-secret",
    devIp: env.DEV_IP ?? "127.0.0.1",
    nickMax: envInt(env, "NICK_MAX", 24),
    textMax: envInt(env, "TEXT_MAX", 1000),
    bannedWords: (env.BANNED_WORDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    bannedWordsMode,
    bannedWordsDir: env.BANNED_WORDS_DIR ?? `${process.cwd()}/data/banned`,
    bannedWordsAllow: (env.BANNED_WORDS_ALLOW ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    retentionDays: envInt(env, "HISTORY_RETENTION_DAYS", 90),
    maxRows: envInt(env, "HISTORY_MAX_ROWS", 500_000),
    backfillMax: envInt(env, "HISTORY_MAX_BACKFILL", 0),
    presenceTtlMs: 45_000,
    pollMs: 1_000,
    presenceUpsertMs: 10_000,
    presenceCountMs: 5_000,
    heartbeatMs: 15_000,
    eventsTtlMs: 3_600_000,
    maintenanceEvery: envInt(env, "MAINTENANCE_EVERY", 100),
    rate: {
      msgPerMin: envInt(env, "MSG_RATE_PER_MIN", 10),
      streamPerMin: envInt(env, "STREAM_RATE_PER_MIN", 20),
      loginPerMin: envInt(env, "LOGIN_RATE_PER_MIN", 5),
      purgePerMin: envInt(env, "PURGE_RATE_PER_MIN", 5),
      windowMs: rateWindowMs,
    },
    allowedOrigins,
    requireOrigin:
      (env.REQUIRE_ORIGIN ?? "false") === "1" ||
      (env.REQUIRE_ORIGIN ?? "").toLowerCase() === "true",
    sessionDays: envInt(env, "ADMIN_SESSION_DAYS", 7),
    cookieName: "wl_admin",
  };
}
