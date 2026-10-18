import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/lib/repo";
import type { Repo } from "../src/lib/repo";
import { createAppWithHandle } from "../src/app";
import { loadConfig, type AppConfig, type Provider } from "../src/lib/config";

export type TestProvider = Provider;

export async function makeRepo(explicit?: TestProvider): Promise<{
  repo: Repo;
  cleanup: () => Promise<void>;
}> {
  const provider = (explicit ??
    process.env.DB_PROVIDER ??
    "sqlite") as TestProvider;
  if (provider === "memory") {
    const repo = await createRepo("memory", "");
    await repo.bootstrap();
    return { repo, cleanup: async () => repo.close() };
  }
  const dir = mkdtempSync(join(tmpdir(), "wl-test-"));
  const url = `file:${join(dir, "test.db")}`;
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

// 由真实 loadConfig 生成：新增 AppConfig 字段时夹具自动跟上，
// 不再因为手写对象漏字段而在无关测试里报 TS2741。
const testBase = loadConfig({
  NODE_ENV: "test",
  DB_PROVIDER: "sqlite",
  DATABASE_URL: "file:cfg-placeholder.db",
  ADMIN_SECRET: "test-secret",
  BANNED_WORDS_MODE: "off",
  BANNED_WORDS: "赌博",
  BANNED_WORDS_DIR: join(tmpdir(), "wl-no-words"),
});

export function testCfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    ...testBase,
    // 下面这些不是 env，只有测试需要毫秒级而不是秒级。
    port: 0,
    pollMs: 10,
    idlePollMs: 10,
    idleAfterMs: 1_000_000,
    eventProbeMs: 0,
    presenceUpsertMs: 10,
    presenceCountMs: 10,
    ...over,
    // rate 里新增字段时，部分覆盖不能把其余限流桶一起抹掉（否则 undefined 会让整桶永远 429）。
    rate: { ...testBase.rate, ...over.rate },
  };
}

export async function makeApp(
  over: Partial<AppConfig> = {},
  provider: TestProvider = "sqlite",
) {
  if (provider === "memory") {
    const cfg = testCfg({ ...over, dbProvider: "memory", databaseUrl: "" });
    const repo = await createRepo("memory", "");
    await repo.bootstrap();
    // handle 里的 maintenance 让测试能用 flush() 等维护确定完成
    const { app, maintenance } = createAppWithHandle({ cfg, repo });
    return {
      cfg,
      app,
      repo,
      maintenance,
      cleanup: async () => {
        await repo.close();
      },
    };
  }
  const dir = mkdtempSync(join(tmpdir(), "wl-app-"));
  // one temp dir shared by cfg and repo so nothing leaks per boot
  const cfg = testCfg({ ...over, databaseUrl: `file:${join(dir, "t.db")}` });
  const repo = await createRepo("sqlite", cfg.databaseUrl);
  await repo.bootstrap();
  const { app, maintenance } = createAppWithHandle({ cfg, repo });
  return {
    cfg,
    app,
    repo,
    maintenance,
    cleanup: async () => {
      await repo.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 页面用 <script src="/retry.js"> 引入退避函数；DOM shim 不执行外链脚本，
 * 所以测试执行同一份源码（读文件 + new Function），保证测的是真实实现。
 * 用 new Function 而不是 import：public/ 没有类型声明，也不该为它开 allowJs。
 */
export function loadRetryScript(): void {
  const src = readFileSync(
    new URL("../public/retry.js", import.meta.url),
    "utf8",
  );
  new Function(src)();
}

export const UUID = "11111111-2222-4333-8444-555555555555";

/** Reads SSE until waitFor matches, then cancels the stream; blocks without data: are skipped. */
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
      // ": ping" 注释与 "retry: 3000" 保留字段都不是事件：没有 data 就跳过，
      // 否则 waitFor 会被一个 data=null 的块误触发。
      if (data === null) continue;
      out.push({ type, data });
      if (waitFor(type, data)) {
        await reader.cancel().catch(() => {});
        return out;
      }
    }
  }
  await reader.cancel().catch(() => {});
  return out;
}
