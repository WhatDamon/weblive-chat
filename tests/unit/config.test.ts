import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/lib/config";

const base = { NODE_ENV: "test", ADMIN_SECRET: "s3cret" };

describe("loadConfig", () => {
  test("默认值：sqlite + file: 本地库、migrate 默认开、限额与保留参数", () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.dbProvider).toBe("sqlite");
    expect(cfg.databaseUrl).toMatch(/^file:/);
    expect(cfg.migrateOnBoot).toBe(true);
    expect(cfg.nickMax).toBe(24);
    expect(cfg.textMax).toBe(1000);
    expect(cfg.retentionDays).toBe(90);
    expect(cfg.maxRows).toBe(500_000);
    expect(cfg.backfillMax).toBe(0);
    expect(cfg.presenceTtlMs).toBe(45_000);
    expect(cfg.rate.msgPerMin).toBe(10);
    expect(cfg.allowedOrigins).toEqual([]);
    expect(cfg.requireOrigin).toBe(false);
  });

  test("DB_PROVIDER=postgres 而无 DATABASE_URL 时启动报错", () => {
    expect(() => loadConfig({ ...base, DB_PROVIDER: "postgres" })).toThrow(/DATABASE_URL/);
  });

  test("生产缺 ADMIN_SECRET 抛错；非生产回退 dev 密钥", () => {
    expect(() => loadConfig({ NODE_ENV: "production", DB_PROVIDER: "sqlite" })).toThrow(/ADMIN_SECRET/);
    const dev = loadConfig({ NODE_ENV: "development", DB_PROVIDER: "sqlite" });
    expect(dev.adminSecret.length).toBeGreaterThan(0);
  });

  test("非法 provider / 非法数值抛错；ALLOWED_ORIGINS 逗号解析并规范化", () => {
    expect(() => loadConfig({ ...base, DB_PROVIDER: "mysql" })).toThrow(/DB_PROVIDER/);
    expect(() => loadConfig({ ...base, NICK_MAX: "-1" })).toThrow(/NICK_MAX/);
    const cfg = loadConfig({ ...base, ALLOWED_ORIGINS: "https://A.com/,https://b.com" });
    expect(cfg.allowedOrigins).toEqual(["https://a.com", "https://b.com"]);
  });
});
