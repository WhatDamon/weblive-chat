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

/**
 * 读取 SSE 响应直到 waitFor 命中（命中即 cancel 流，单次消费语义）。
 * 只收 data 帧（SSE 注释行如 ": ping" 无 data: 前缀，data 为 null 不 push，也不触发 waitFor）。
 */
export async function readSse(
  res: Response,
  waitFor: (type: string, data: any) => boolean,
  timeoutMs = 3000,
): Promise<{ type: string; data: any }[]> {
  const out: { type: string; data: any }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = block.split("\n");
      let type = "message";
      let data: any = null;
      for (const line of lines) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:"))
          data = JSON.parse(line.slice(5).trim());
      }
      if (data !== null) out.push({ type, data });
      if (waitFor(type, data)) {
        await reader.cancel().catch(() => {});
        return out;
      }
    }
  }
  await reader.cancel().catch(() => {});
  return out;
}
