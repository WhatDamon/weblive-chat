import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/lib/repo";
import type { Repo } from "../src/lib/repo";
import { createApp } from "../src/app";
import type { AppConfig } from "../src/lib/config";

export async function makeRepo(): Promise<{
  repo: Repo;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "wl-test-"));
  const url = `file:${join(dir, "test.db")}`;
  const provider =
    (process.env.DB_PROVIDER as "sqlite" | "postgres") ?? "sqlite";
  const realUrl = provider === "sqlite" ? url : process.env.DATABASE_URL!;
  const repo = await createRepo(provider, realUrl);
  await repo.bootstrap();
  return {
    repo,
    cleanup: async () => {
      await repo.close();
      if (provider === "sqlite") rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function testCfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    env: "test",
    port: 0,
    dbProvider: "sqlite",
    // databaseUrl 仅作类型占位：真实连接统一由 makeApp 用可清理目录创建（见下）
    databaseUrl: "file:cfg-placeholder.db",
    migrateOnBoot: true,
    adminSecret: "test-secret",
    devIp: "127.0.0.1",
    nickMax: 24,
    textMax: 1000,
    bannedWords: ["赌博"],
    retentionDays: 90,
    maxRows: 500_000,
    backfillMax: 0,
    presenceTtlMs: 45_000,
    pollMs: 10,
    presenceUpsertMs: 10,
    presenceCountMs: 10,
    heartbeatMs: 15_000,
    eventsTtlMs: 3_600_000,
    maintenanceEvery: 100,
    rate: { msgPerMin: 10, streamPerMin: 20, loginPerMin: 5, windowMs: 60_000 },
    allowedOrigins: [],
    requireOrigin: false,
    sessionDays: 7,
    cookieName: "wl_admin",
    ...over,
  };
}

export async function makeApp(over: Partial<AppConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wl-app-"));
  // cfg 与 repo 共用同一目录同一库文件，避免 testCfg 每 boot 泄漏空 /tmp 目录
  const cfg = testCfg({ ...over, databaseUrl: `file:${join(dir, "t.db")}` });
  const repo = await createRepo("sqlite", cfg.databaseUrl);
  await repo.bootstrap();
  const app = createApp({ cfg, repo });
  return {
    cfg,
    app,
    repo,
    cleanup: async () => {
      await repo.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const UUID = "11111111-2222-4333-8444-555555555555";
