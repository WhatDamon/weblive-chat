import { describe, expect, test } from "bun:test";
import { join } from "node:path";
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
    expect(() => loadConfig({ ...base, DB_PROVIDER: "postgres" })).toThrow(
      /DATABASE_URL/,
    );
  });

  test("生产缺 ADMIN_SECRET 抛错；非生产回退 dev 密钥", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", DB_PROVIDER: "sqlite" }),
    ).toThrow(/ADMIN_SECRET/);
    const dev = loadConfig({ NODE_ENV: "development", DB_PROVIDER: "sqlite" });
    expect(dev.adminSecret.length).toBeGreaterThan(0);
  });

  test("非法 provider / 非法数值抛错；ALLOWED_ORIGINS 逗号解析并规范化", () => {
    expect(() => loadConfig({ ...base, DB_PROVIDER: "mysql" })).toThrow(
      /DB_PROVIDER/,
    );
    expect(() => loadConfig({ ...base, NICK_MAX: "-1" })).toThrow(/NICK_MAX/);
    const cfg = loadConfig({
      ...base,
      ALLOWED_ORIGINS: "https://A.com/,https://b.com",
    });
    expect(cfg.allowedOrigins).toEqual(["https://a.com", "https://b.com"]);
  });

  test("ALLOWED_ORIGINS=* 等价于全开（避免写成 * 反而锁死全部来源）", () => {
    expect(loadConfig({ ...base, ALLOWED_ORIGINS: "*" }).allowedOrigins).toEqual(
      [],
    );
    expect(
      loadConfig({ ...base, ALLOWED_ORIGINS: "https://a.com,*" }).allowedOrigins,
    ).toEqual([]);
    expect(
      loadConfig({ ...base, ALLOWED_ORIGINS: "  " }).allowedOrigins,
    ).toEqual([]);
  });

  test("DB_PROVIDER=memory：无需 DATABASE_URL，供本地/单实例纯内存演示", () => {
    const cfg = loadConfig({ ...base, DB_PROVIDER: "memory" });
    expect(cfg.dbProvider).toBe("memory");
    expect(cfg.databaseUrl).toBe("");
    expect(cfg.adminSecret.length).toBeGreaterThan(0); // 非生产仍可用 dev 回退
  });

  test("DB_PROVIDER=memory + 生产环境抛错（不适用于 Vercel/Serverless）", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DB_PROVIDER: "memory",
        ADMIN_SECRET: "s3cret",
      }),
    ).toThrow(/memory/);
  });

  test("违禁词库：默认 basic + 内置目录，模式/目录/白名单可覆盖，非法模式抛错", () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.bannedWordsMode).toBe("basic");
    expect(cfg.bannedWordsDir).toBe(join(process.cwd(), "data/banned"));
    expect(cfg.bannedWordsAllow).toEqual([]);
    const over = loadConfig({
      ...base,
      BANNED_WORDS_MODE: "strict",
      BANNED_WORDS_DIR: "/tmp/words",
      BANNED_WORDS_ALLOW: "赌博合法, 抽奖活动 ",
    });
    expect(over.bannedWordsMode).toBe("strict");
    expect(over.bannedWordsDir).toBe("/tmp/words");
    expect(over.bannedWordsAllow).toEqual(["赌博合法", "抽奖活动"]);
    expect(() => loadConfig({ ...base, BANNED_WORDS_MODE: "loose" })).toThrow(
      /BANNED_WORDS_MODE/,
    );
  });
});
