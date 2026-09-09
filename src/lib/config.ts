export type Provider = "sqlite" | "postgres";

export interface RateCfg {
  msgPerMin: number;
  streamPerMin: number;
  loginPerMin: number;
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
  devIp: string; // 本地无代理时 x-forwarded-for 缺失的回退
  // 限额
  nickMax: number;
  textMax: number;
  bannedWords: string[];
  // 保留/降级
  retentionDays: number;
  maxRows: number;
  backfillMax: number;
  // 实时
  presenceTtlMs: number;
  pollMs: number;
  presenceUpsertMs: number;
  presenceCountMs: number;
  heartbeatMs: number;
  eventsTtlMs: number;
  maintenanceEvery: number;
  rate: RateCfg;
  // 安全
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
    throw new Error(`环境变量 ${key} 必须是非负数字，收到 "${v}"`);
  return Math.floor(n);
};

export function loadConfig(
  env: Record<string, string | undefined> = {},
): AppConfig {
  const provider = env.DB_PROVIDER ?? "sqlite";
  if (provider !== "sqlite" && provider !== "postgres")
    throw new Error(`DB_PROVIDER 仅支持 sqlite|postgres，收到 "${provider}"`);
  const databaseUrl =
    env.DATABASE_URL ?? (provider === "sqlite" ? "file:./data/dev.db" : "");
  if (provider === "postgres" && !/^postgres(ql)?:\/\//.test(databaseUrl))
    throw new Error("DB_PROVIDER=postgres 时必须提供 DATABASE_URL");
  const envName = env.NODE_ENV ?? "development";
  const adminSecret = env.ADMIN_SECRET ?? "";
  if (envName === "production" && !adminSecret)
    throw new Error("生产环境必须设置 ADMIN_SECRET");
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/\/+$/, ""))
    .filter(Boolean);
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
