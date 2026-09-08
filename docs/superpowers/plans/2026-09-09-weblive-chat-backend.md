# weblive-chat 后端 + 内置验证 Demo 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现免登录实时聊天后端（SSE + POST 契约、在线人数、管理员封禁/删消息、限流防滥用、自动收缩降级），随仓库内置零构建验证 Demo 与管理页，可直接部署到 Vercel（默认 Turso/可选 Postgres），Bun 管理。

**架构：** Hono app 在本地（Bun.serve）与 Vercel（`hono/node-serverless` 单函数）跑同一份代码。跨实例广播用 DB 出站表 `events`，每个 SSE 流每 ~1s 增量轮询（游标 `since`）；presence 心跳表按 `client_id` 去重统计在线"人数"；限流计数落库原子自增（`rate_limits`）；保留策略由"行数 × 天数"确定性推导，超限自动逐级收缩/降级为仅实时。存储层为**手写可移植 SQL 仓库**（不引 ORM），方言差异隔离在 `lib/repo.ts` 内。

**技术栈：** Bun（运行/测试/脚本）、Hono（路由 + SSE）、`@libsql/client`（`file:`/`libsql:` 双形态）、`postgres.js`（可选 PG）、`node:crypto`（HMAC Cookie 签名）。开发依赖：`typescript`、`@types/bun`（已有）。

**规格：** `docs/superpowers/specs/2026-09-09-weblive-chat-backend-design.md`（决策 D1–D16、§4 五表模型 + `rate_limits`、§5 API 契约、§6.1 Origin 白名单、§7.2 自动收缩/降级、§8 测试矩阵）。实现者两份都读；本计划中与规格不一致处以规格为准，发现矛盾先停下汇报。

## 全局约束（每条数值逐字照抄规格/已拍板决定，所有任务隐含包含）

- 免登录：客户端自持 `client_id`（UUID）；管理员 = `ADMIN_SECRET` 口令 → HttpOnly、`SameSite=Lax`、`Path=/` 签名 Cookie（HMAC-SHA256，默认 7 天过期）。
- 仓库**零敏感数据**：密钥/连接串只走环境变量；只提交 `.env.example`。
- `DB_PROVIDER`：`sqlite` | `postgres`（默认 `sqlite`）。`DATABASE_URL`：`file:`（仅本地开发/测试）、`libsql://…`（Turso 生产）、`postgres://…`（Neon/Supabase/自建）。`DB_MIGRATE_ON_BOOT` 默认开：首次请求前执行幂等 `CREATE TABLE IF NOT EXISTS`（启动自建表，D13/D16）。
- **Vercel 函数文件系统是临时的**：`file:` 型 SQLite 禁止作 Vercel 生产存储。
- 时间一律 epoch ms 整数、应用层算好传参，SQL 层禁 `now()`/`interval`/方言时间函数；所有 API `id`/游标序列化为字符串；时间输出 ISO 8601 UTC。
- 端口/限额默认：`NICK_MAX=24`、`TEXT_MAX=1000`、`HISTORY_RETENTION_DAYS=90`、`HISTORY_MAX_ROWS=500_000`、`HISTORY_MAX_BACKFILL=0`（0=不限深）、presence TTL 45s、events 保留 1h、限流 msg 10/min、stream 20/min、login 5/min（60s 固定窗口）。
- 封禁 = **禁言不禁看**（D5）：只拦截发消息；已开流不断、仍可旁观；命中 IP 的流开流时收到 `ban` 提示事件（payload `{reason}`）。
- 在线口径 = 按 `client_id` 去重（同浏览器多标签 = 1）：SSE 需带可选 `client_id` 参数归因 presence。
- 错误统一信封：`{"error":{"code":string,"message":string,"retry_after_ms"?:number}}`；管理类变更/创建接口要求 `Content-Type: application/json`。
- Origin 白名单（§6.1）：`ALLOWED_ORIGINS` 未设置 = 开放模式；设置后 fail-closed（`403 origin_not_allowed`）；无 Origin 直连默认放行，`REQUIRE_ORIGIN=1` 收紧。精确匹配、回显 ACAO、`Vary: Origin`。
- 测试矩阵（§8）：单元恒跑；集成**默认对本地 `file:` SQLite 全跑**；设了 `DB_PROVIDER=postgres` + `DATABASE_URL` 时同一套再跑 Postgres。
- 上传/删除类型：`events.type ∈ message|delete|ban|notice`；mode 阶梯 90→30→10→3→1 天 → `ephemeral`（停写 `messages` 仅实时，`/api/messages` 返回 `{messages:[],mode:"ephemeral"}`）。
- 软删占位：`deleted_at` 置位、`text` 清空、保留 `id`/时间；`deleted_by` 只存固定标识（不落操作者 IP）。

---

### 文件结构（任务分解的依据）

**新建：**

- `src/lib/config.ts` — 环境变量加载/校验/默认值（全部旋钮，类型 `AppConfig`）
- `src/lib/ddl.ts` — 按 provider 的幂等建表 DDL 数组（sqlite / pg）
- `src/lib/repo.ts` — 手写可移植 SQL 数据访问层：`Repo` 接口 + `createRepo(provider,url)` 双驱动实现（含事务双写、引导、清洗/统计）
- `src/lib/http.ts` — 响应助手：`jsonError`、JSON body 读取、游标/`client_id` 解析错误映射
- `src/lib/security.ts` — IP 解析/规范化、Origin 白名单判定、HMAC 签名 Cookie、常量时间比较
- `src/lib/validate.ts` — 昵称/文本清洗、UUID、禁词、消息体校验
- `src/lib/limits.ts` — 限流判定（调 `repo.rateHit` 原子计数，纯逻辑可测）
- `src/lib/history.ts` — 保留策略：`decideHistory`（纯）+ 维护执行（清理 events/presence/rate_limits/过期消息 + 超行数裁剪）
- `src/lib/stream.ts` — SSE 流控制器 `runStream`（轮询/游标回退/presence 广播/心跳/禁言提示；依赖 `StreamRepo` 子接口，可假库单测）
- `src/app.ts` — `createApp(cfg, repo)`：Hono 装配、`/api` 中间件（Origin 闸口 + 错误映射）、挂 chat/admin/pages 路由、惰性 boot
- `src/routes/chat.ts` — 公开端点：meta / messages（before/since）/ POST messages / stream
- `src/routes/admin.ts` — 管理 JSON API（login/logout/me/stats/bans/messages delete）
- `src/routes/pages.ts` — 同源静态页（`/demo.html`、`/admin`、`/admin.html`、`/` → `/demo.html`）
- `src/index.ts` — 入口：`Bun.serve` dev server（直接运行）或 `export default handle(app)`（Vercel）
- `public/demo.html`、`public/admin.html` — 零构建页面
- `vercel.json`、`tsconfig.json`、`.env.example`
- `docs/api.md`、`docs/superpowers/plans/README.md`（可选，记录执行状态）
- `tests/helpers.ts`、`tests/unit/*.test.ts`、`tests/integration/*.test.ts`

**修改：**

- `package.json`（scripts + 依赖）、`.gitignore`（追加 `data/`）、`README.md`（重写使用说明）

**任务依赖顺序：** T1 配置 → T2 数据层 → T3 安全/校验/限流纯库 → T4 历史策略 + 流控制器 → T5 chat 路由（无流）→ T6 SSE 集成 → T7 admin API → T8 页面与 Demo → T9 部署形态/入口 → T10 文档与全量验收。

---

## 任务 1：工程骨架与配置加载

**文件：**

- 创建：`src/lib/config.ts`、`tsconfig.json`、`.env.example`
- 修改：`package.json`、`.gitignore`（追加 `data/`）
- 测试：`tests/unit/config.test.ts`

- [ ] **步骤 1：安装依赖并写配置测试（先红）**

```bash
bun add hono @libsql/client postgres
bun add -d typescript
```

`tests/unit/config.test.ts`：

```ts
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
```

- [ ] **步骤 2：运行测试确认失败**

运行：`bun test tests/unit/config.test.ts`
预期：FAIL（`loadConfig` 不存在 / 模块解析失败）

- [ ] **步骤 3：实现配置加载与默认值**

`src/lib/config.ts`：

```ts
export type Provider = "sqlite" | "postgres";

export interface RateCfg { msgPerMin: number; streamPerMin: number; loginPerMin: number; windowMs: number }

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
  nickMax: number; textMax: number; bannedWords: string[];
  // 保留/降级
  retentionDays: number; maxRows: number; backfillMax: number;
  // 实时
  presenceTtlMs: number; pollMs: number; presenceUpsertMs: number; presenceCountMs: number; heartbeatMs: number;
  eventsTtlMs: number; maintenanceEvery: number;
  rate: RateCfg;
  // 安全
  allowedOrigins: string[]; requireOrigin: boolean;
  sessionDays: number;
  cookieName: string;
}

const envInt = (env: Record<string, string | undefined>, key: string, def: number): number => {
  const v = env[key];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`环境变量 ${key} 必须是非负数字，收到 "${v}"`);
  return Math.floor(n);
};

export function loadConfig(env: Record<string, string | undefined> = {}): AppConfig {
  const provider = env.DB_PROVIDER ?? "sqlite";
  if (provider !== "sqlite" && provider !== "postgres") throw new Error(`DB_PROVIDER 仅支持 sqlite|postgres，收到 "${provider}"`);
  const databaseUrl = env.DATABASE_URL ?? (provider === "sqlite" ? "file:./data/dev.db" : "");
  if (provider === "postgres" && !/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error("DB_PROVIDER=postgres 时必须提供 DATABASE_URL");
  const envName = env.NODE_ENV ?? "development";
  const adminSecret = env.ADMIN_SECRET ?? "";
  if (envName === "production" && !adminSecret) throw new Error("生产环境必须设置 ADMIN_SECRET");
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "")
    .split(",").map(s => s.trim().toLowerCase().replace(/\/+$/, "")).filter(Boolean);
  const rateWindowMs = 60_000;
  return {
    env: envName, port: envInt(env, "PORT", 3000),
    dbProvider: provider, databaseUrl, tursoAuthToken: env.TURSO_AUTH_TOKEN,
    migrateOnBoot: (env.DB_MIGRATE_ON_BOOT ?? "true") !== "false",
    adminSecret: adminSecret || "dev-insecure-secret",
    devIp: env.DEV_IP ?? "127.0.0.1",
    nickMax: envInt(env, "NICK_MAX", 24), textMax: envInt(env, "TEXT_MAX", 1000),
    bannedWords: (env.BANNED_WORDS ?? "").split(",").map(s => s.trim()).filter(Boolean),
    retentionDays: envInt(env, "HISTORY_RETENTION_DAYS", 90),
    maxRows: envInt(env, "HISTORY_MAX_ROWS", 500_000),
    backfillMax: envInt(env, "HISTORY_MAX_BACKFILL", 0),
    presenceTtlMs: 45_000, pollMs: 1_000, presenceUpsertMs: 10_000,
    presenceCountMs: 5_000, heartbeatMs: 15_000, eventsTtlMs: 3_600_000,
    maintenanceEvery: envInt(env, "MAINTENANCE_EVERY", 100),
    rate: { msgPerMin: envInt(env, "MSG_RATE_PER_MIN", 10), streamPerMin: envInt(env, "STREAM_RATE_PER_MIN", 20), loginPerMin: envInt(env, "LOGIN_RATE_PER_MIN", 5), windowMs: rateWindowMs },
    requireOrigin: (env.REQUIRE_ORIGIN ?? "false") === "1" || (env.REQUIRE_ORIGIN ?? "").toLowerCase() === "true",
    sessionDays: envInt(env, "ADMIN_SESSION_DAYS", 7),
    cookieName: "wl_admin",
  };
}
```

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "types": ["bun-types"],
    "verbatimModuleSyntax": true
  },
  "include": ["src", "tests", "public"]
}
```

`.env.example`（唯一密钥模板，注释齐全）：

```env
# ---- 数据库（本实现期不引 ORM，见规格 D16）----
DB_PROVIDER=sqlite            # sqlite | postgres
# sqlite：本地开发/测试用 file:；生产 SQLite 必须走远程 Turso（Vercel 文件系统临时）
DATABASE_URL=file:./data/dev.db
# 生产 SQLite（Turso）：DATABASE_URL=libsql://<db>-<org>.turso.io  另需 TURSO_AUTH_TOKEN
# 生产 Postgres（Neon/Supabase/自建）：DATABASE_URL=postgres://user:pass@host/db?sslmode=require
TURSO_AUTH_TOKEN=
DB_MIGRATE_ON_BOOT=true       # 启动幂等建表（首次请求前 CREATE TABLE IF NOT EXISTS）

# ---- 管理员（必配：生产不设则启动失败）----
ADMIN_SECRET=replace-with-a-long-random-string

# ---- 来源白名单（§6.1）----
ALLOWED_ORIGINS=              # 空 = 开放模式；逗号分隔精确 Origin，如 https://a.com,http://localhost:3000
REQUIRE_ORIGIN=0              # 1 = 无 Origin 直连拒绝

# ---- 聊天/保留 ----
NICK_MAX=24
TEXT_MAX=1000
BANNED_WORDS=                 # 逗号分隔禁词（子串匹配）
HISTORY_RETENTION_DAYS=90
HISTORY_MAX_ROWS=500000
HISTORY_MAX_BACKFILL=0        # 0=不限制回溯深度；正整数=仅回溯最近 N 条

# ---- 限流（每 IP / 60s 窗口）----
MSG_RATE_PER_MIN=10
STREAM_RATE_PER_MIN=20
LOGIN_RATE_PER_MIN=5

# ---- 运行 ----
PORT=3000
```

`package.json`（修改 scripts 与 engines）：

```json
{
  "scripts": {
    "dev": "bun --hot src/index.ts",
    "start": "bun src/index.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "test:pg": "DB_PROVIDER=postgres bun test tests/integration"
  }
}
```

`.gitignore` 追加 `data/`。

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test tests/unit/config.test.ts`
预期：PASS（3 组 4 用例）

- [ ] **步骤 5：Commit**

```bash
git add package.json tsconfig.json .env.example src/lib/config.ts tests/unit/config.test.ts .gitignore
git commit -m "feat: project scaffolding and typed env config (T1)"
```

---

## 任务 2：数据层 —— 幂等 DDL + 双驱动 Repo

**文件：**

- 创建：`src/lib/ddl.ts`、`src/lib/repo.ts`、`tests/helpers.ts`
- 测试：`tests/integration/repo.test.ts`

- [ ] **步骤 1：写 Repo 集成测试（先红，sqlite file:）**

`tests/helpers.ts`（本任务只建 repo 部分，T5 追加 app 部分）：

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo, Repo } from "../src/lib/repo";

export async function makeRepo(): Promise<{ repo: Repo; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "wl-test-"));
  const url = `file:${join(dir, "test.db")}`;
  const provider = (process.env.DB_PROVIDER as "sqlite" | "postgres") ?? "sqlite";
  const realUrl = provider === "sqlite" ? url : process.env.DATABASE_URL!;
  const repo = await createRepo(provider, realUrl);
  await repo.bootstrap();
  return { repo, cleanup: async () => { await repo.close(); if (provider === "sqlite") rmSync(dir, { recursive: true, force: true }); } };
}
```

`tests/integration/repo.test.ts`（同一套用例 = §8 双库跑；`bun test` 默认 sqlite，`bun run test:pg` 跑 PG）：

```ts
import { describe, expect, test } from "bun:test";
import { makeRepo } from "../helpers";

describe("Repo 双库契约", () => {
  test("bootstrap 幂等：可重复调用", async () => {
    const { repo, cleanup } = await makeRepo();
    await repo.bootstrap();
    await repo.bootstrap();
    await cleanup();
  });

  test("sendMessageAndEvent 事务双写：返回两个自增 id，messages 与 events 各一行", async () => {
    const { repo, cleanup } = await makeRepo();
    const now = Date.now();
    const { messageId, eventId } = await repo.sendMessageAndEvent(
      { client_id: "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1", nick: "甲", text: "你好", created_at: now },
    );
    expect(messageId).toBeGreaterThan(0);
    expect(eventId).toBeGreaterThan(0);
    const hist = await repo.historyBefore(Number.MAX_SAFE_INTEGER, 10);
    expect(hist).toHaveLength(1);
    expect(hist[0].nick).toBe("甲");
    const evs = await repo.eventsSince(0, 10);
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe("message");
    // payload 由事务方法内部构造：含消息 id 与全文（客户端去重依据）
    const pl = JSON.parse(evs[0].payload);
    expect(pl.id).toBe(String(messageId));
    expect(pl.text).toBe("你好");
    await cleanup();
  });

  test("historyBefore 新→旧 / historySince 旧→新 / 软删映射 text=null", async () => {
    const { repo, cleanup } = await makeRepo();
    const now = Date.now();
    const sent: { messageId: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await repo.sendMessageAndEvent(
        { client_id: "c", nick: "n", text: `m${i}`, created_at: now + i },
      );
      sent.push(r);
    }
    const before = await repo.historyBefore(sent[2].messageId, 10);
    expect(before.map(m => m.text)).toEqual(["m1", "m0"]); // < id2，降序
    const since = await repo.historySince(sent[0].messageId, 10);
    expect(since.map(m => m.text)).toEqual(["m1", "m2"]);
    const ok = await repo.softDeleteMessage(sent[1].messageId, "admin", now + 100);
    expect(ok).toBe(true);
    const all = await repo.historyBefore(Number.MAX_SAFE_INTEGER, 10);
    expect(all.find(m => m.id === sent[1].messageId)).toMatchObject({ text: null, deleted: true });
    await cleanup();
  });

  test("封禁：upsert 幂等、get/list/remove", async () => {
    const { repo, cleanup } = await makeRepo();
    expect(await repo.banUpsert("1.2.3.4", "spam", "admin", Date.now())).toBe(true);
    expect(await repo.banUpsert("1.2.3.4", "spam2", "admin", Date.now())).toBe(false); // 已存在
    expect((await repo.banGet("1.2.3.4"))?.reason).toBe("spam2");
    expect(await repo.banList(100, 0)).toHaveLength(1);
    expect(await repo.banRemove("1.2.3.4")).toBe(true);
    expect(await repo.banGet("1.2.3.4")).toBeNull();
    await cleanup();
  });

  test("presence upsert 覆盖 + count 按 TTL 过滤", async () => {
    const { repo, cleanup } = await makeRepo();
    await repo.presenceUpsert("a", 1000);
    await repo.presenceUpsert("a", 2000); // 覆盖
    await repo.presenceUpsert("b", 9000);
    expect(await repo.presenceCount(5000)).toBe(1); // a 过期
    expect(await repo.presenceCount(0)).toBe(2);
    await cleanup();
  });

  test("rateHit 原子自增到超限；独立 scope 互不影响", async () => {
    const { repo, cleanup } = await makeRepo();
    for (let i = 1; i <= 3; i++) expect(await repo.rateHit("msg", "9.9.9.9", 0)).toBe(i);
    expect(await repo.rateHit("msg", "8.8.8.8", 0)).toBe(1);
    expect(await repo.rateHit("stream", "9.9.9.9", 0)).toBe(1); // 不同桶独立
    await cleanup();
  });

  test("清洗与统计：events/presence/rate_limits 过期删除、消息超行数裁剪、day 裁剪", async () => {
    const { repo, cleanup } = await makeRepo();
    await repo.insertEvent("notice", "{}", 1000);
    expect(await repo.cleanupEvents(2000)).toBe(1);
    await repo.presenceUpsert("gone", 1000);
    expect(await repo.cleanupPresence(5000)).toBe(1);
    await repo.rateHit("msg", "9.9.9.9", 0);
    expect(await repo.cleanupRateLimits(100)).toBe(1);
    // 消息行数裁剪：造 5 行，floor 后仅留 ≥ floor
    for (let i = 0; i < 5; i++) await repo.sendMessageAndEvent({ client_id: "c", nick: "n", text: `t${i}`, created_at: 1 });
    const stats = await repo.messageStats();
    expect(stats.total).toBe(5);
    const keep = (await repo.historyBefore(Number.MAX_SAFE_INTEGER, 10))[2].id; // 保留最新的 3 条 → floor 为第 3 新
    await repo.trimMessagesBelow(keep);
    expect((await repo.messageStats()).total).toBe(3);
    await repo.deleteMessagesOlderThan(50); // created_at=1 < 50 → 全删
    expect((await repo.messageStats()).total).toBe(0);
    await cleanup();
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`bun test tests/integration/repo.test.ts`
预期：FAIL（模块/类型不存在）

- [ ] **步骤 3：实现 DDL 与 Repo**

`src/lib/ddl.ts` —— 每 provider 一套幂等 DDL（仅 `id` 与整数列类型不同）：

```ts
import type { Provider } from "./config";

export function ddlFor(provider: Provider): readonly string[] {
  const idCol = provider === "sqlite" ? "id INTEGER PRIMARY KEY AUTOINCREMENT" : "id serial PRIMARY KEY";
  const int = provider === "sqlite" ? "INTEGER" : "bigint";
  return [
    `CREATE TABLE IF NOT EXISTS messages (
      ${idCol}, client_id text NOT NULL, nick text NOT NULL, text text NOT NULL,
      created_at ${int} NOT NULL, deleted_at ${int}, deleted_by text)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at)`,
    `CREATE TABLE IF NOT EXISTS events (
      ${idCol}, type text NOT NULL, payload text NOT NULL, created_at ${int} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS presence (client_id text PRIMARY KEY, last_seen ${int} NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_presence_last_seen ON presence (last_seen)`,
    `CREATE TABLE IF NOT EXISTS bans (
      ip text PRIMARY KEY, reason text NOT NULL, banned_by text NOT NULL, created_at ${int} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS rate_limits (
      bucket text NOT NULL, scope text NOT NULL, window_start ${int} NOT NULL,
      count integer NOT NULL, PRIMARY KEY (bucket, scope, window_start))`,
  ];
}
```

`src/lib/repo.ts` —— 行类型 + 接口 + 双驱动实现。SQL 模板统一用 `?` 占位，PG 层转换 `$n`（同一语句单源、无双份 SQL）：

```ts
import { createClient, type Client } from "@libsql/client";
import postgres from "postgres";
import type { Provider } from "./config";
import { ddlFor } from "./ddl";

export interface MessageRow {
  id: number; client_id: string; nick: string;
  text: string | null; created_at: number;
  deleted: boolean; deleted_at: number | null;
}
export interface EventRow { id: number; type: string; payload: string; created_at: number }

export interface Repo {
  readonly provider: Provider;
  bootstrap(): Promise<void>;
  close(): Promise<void>;
  /** events + messages 单事务双写（SQLite BEGIN IMMEDIATE / PG begin）。
   * 事件类型恒为 message；payload 由实现**在事务内拿到 messageId 后自动构造**：
   * `{id: String(messageId), client_id, nick, text, created_at}`（含 id 供客户端去重/对应 delete）。 */
  sendMessageAndEvent(m: { client_id: string; nick: string; text: string; created_at: number }): Promise<{ messageId: number; eventId: number }>;
  /** 仅实时（ephemeral 模式，§7.2）广播：只写 events、不写 messages；payload id 形如 "e<eventId>"（避开 messages.id 命名空间，避免 delete 误伤）。
   * 内部先插空 payload 取 eventId，再在**同一事务**内 UPDATE 为完整 JSON。 */
  publishEphemeralMessage(m: { client_id: string; nick: string; text: string; created_at: number }): Promise<{ eventId: number }>;
  insertEvent(type: string, payload: string, created_at: number): Promise<number>;
  eventsSince(since: number, limit: number): Promise<EventRow[]>;
  eventsMaxId(): Promise<number>;
  historyBefore(before: number, limit: number): Promise<MessageRow[]>;
  historySince(since: number, limit: number): Promise<MessageRow[]>;
  softDeleteMessage(id: number, by: string, at: number): Promise<boolean>;
  banUpsert(ip: string, reason: string, by: string, at: number): Promise<boolean>;
  banGet(ip: string): Promise<{ reason: string; created_at: number } | null>;
  banList(limit: number, offset: number): Promise<{ ip: string; reason: string; created_at: number }[]>;
  banRemove(ip: string): Promise<boolean>;
  presenceUpsert(clientId: string, at: number): Promise<void>;
  presenceCount(cutoff: number): Promise<number>;
  rateHit(bucket: string, scope: string, windowStart: number): Promise<number>;
  messageStats(): Promise<{ total: number; retained: number }>;
  cleanupEvents(before: number): Promise<number>;
  cleanupPresence(before: number): Promise<number>;
  cleanupRateLimits(before: number): Promise<number>;
  trimMessagesBelow(idFloor: number): Promise<number>;
  deleteMessagesOlderThan(cutoff: number): Promise<number>;
}
```

行映射与实现要点（完整实现见下）：

```ts
const mapMessage = (r: any): MessageRow => ({
  id: Number(r.id), client_id: r.client_id, nick: r.nick,
  text: r.deleted_at === null || r.deleted_at === undefined ? r.text : null,
  created_at: Number(r.created_at), deleted: !(r.deleted_at === null || r.deleted_at === undefined),
  deleted_at: r.deleted_at === null || r.deleted_at === undefined ? null : Number(r.deleted_at),
});

// SQL 模板（仅含 ? 占位；SELECT 后追 RETURNING/双写事务语句按方言微调，见 impl）
const SQL = {
  insMessage: "INSERT INTO messages (client_id, nick, text, created_at) VALUES (?, ?, ?, ?)",
  insEvent: "INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)",
  eventsSince: "SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?",
  maxEventId: "SELECT COALESCE(MAX(id), 0) AS m FROM events",
  before: "SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?",
  since: "SELECT * FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?",
  softDel: "UPDATE messages SET deleted_at = ?, deleted_by = ?, text = '' WHERE id = ? AND deleted_at IS NULL",
  banGet: "SELECT reason, created_at FROM bans WHERE ip = ?",
  banList: "SELECT ip, reason, created_at FROM bans ORDER BY created_at DESC LIMIT ? OFFSET ?",
  banDel: "DELETE FROM bans WHERE ip = ?",
  presUp: "INSERT INTO presence (client_id, last_seen) VALUES (?, ?) ON CONFLICT (client_id) DO UPDATE SET last_seen = excluded.last_seen",
  presCnt: "SELECT COUNT(*) AS c FROM presence WHERE last_seen > ?",
  rateHit: `INSERT INTO rate_limits (bucket, scope, window_start, count) VALUES (?, ?, ?, 1)
            ON CONFLICT (bucket, scope, window_start) DO UPDATE SET count = count + 1 RETURNING count`,
  stats: "SELECT COUNT(*) AS total, COUNT(deleted_at) AS del FROM messages",
  delEvents: "DELETE FROM events WHERE created_at < ?",
  delPres: "DELETE FROM presence WHERE last_seen < ?",
  delRates: "DELETE FROM rate_limits WHERE window_start < ?",
  trimBelow: "DELETE FROM messages WHERE id < ?",
  delOlder: "DELETE FROM messages WHERE created_at < ?",
};
```

驱动封装（PG 层把 `?` 转 `$n`；libsql 用 `execute({sql, args})`）：

```ts
const toPg = (sql: string) => sql.replace(/\?/g, () => `$${++pgIdx()}`) // 见下方 impl 内实现
```

sqlite 实现（`@libsql/client`）：

```ts
class SqliteRepo implements Repo {
  readonly provider = "sqlite" as const;
  constructor(private c: Client) {}
  async bootstrap() { for (const d of ddlFor("sqlite")) await this.c.execute(d); }
  async close() { this.c.close(); }
  private async run<T>(sql: string, args: unknown[]): Promise<T> {
    const r = await this.c.execute({ sql, args: args as any[] });
    return r.rows as unknown as T;
  }
  private async exec(sql: string, args: unknown[] = []) { await this.c.execute({ sql, args: args as any[] }); }

  async sendMessageAndEvent(m) {
    await this.exec("BEGIN IMMEDIATE");
    try {
      const ins = await this.c.execute({ sql: SQL.insMessage, args: [m.client_id, m.nick, m.text, m.created_at] });
      const messageId = Number(ins.lastInsertRowid);
      const payload = JSON.stringify({ id: String(messageId), client_id: m.client_id, nick: m.nick, text: m.text, created_at: m.created_at });
      const ev = await this.c.execute({ sql: SQL.insEvent, args: ["message", payload, m.created_at] });
      const eventId = Number(ev.lastInsertRowid);
      await this.exec("COMMIT");
      return { messageId, eventId };
    } catch (err) {
      await this.exec("ROLLBACK").catch(() => {});
      throw err;
    }
  }

  async publishEphemeralMessage(m) {
    await this.exec("BEGIN IMMEDIATE");
    try {
      const ev = await this.c.execute({ sql: SQL.insEvent, args: ["message", "", m.created_at] });
      const eventId = Number(ev.lastInsertRowid);
      const payload = JSON.stringify({ id: `e${eventId}`, client_id: m.client_id, nick: m.nick, text: m.text, created_at: m.created_at });
      await this.exec("UPDATE events SET payload = ? WHERE id = ?", [payload, eventId]);
      await this.exec("COMMIT");
      return { eventId };
    } catch (err) { await this.exec("ROLLBACK").catch(() => {}); throw err; }
  }
  async insertEvent(type, payload, created_at) {
    const r = await this.c.execute({ sql: SQL.insEvent, args: [type, payload, created_at] });
    return Number(r.lastInsertRowid);
  }
  async eventsSince(since, limit) { return this.run<any[]>(SQL.eventsSince, [since, limit]); }
  async eventsMaxId() { const r = await this.run<any[]>(SQL.maxEventId, []); return Number(r[0]?.m ?? 0); }
  async historyBefore(before, limit) { return (await this.run<any[]>(SQL.before, [before, limit])).map(mapMessage); }
  async historySince(since, limit) { return (await this.run<any[]>(SQL.since, [since, limit])).map(mapMessage); }
  async softDeleteMessage(id, by, at) { const r = await this.c.execute({ sql: SQL.softDel, args: [at, by, id] }); return Number(r.rowsAffected) > 0; }
  async banUpsert(ip, reason, by, at) {
    const r = await this.c.execute({ sql: "INSERT INTO bans (ip, reason, banned_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (ip) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by, created_at = excluded.created_at", args: [ip, reason, by, at] });
    return Number(r.rowsAffected) > 0;
  }
  async banGet(ip) { const r = await this.run<any[]>(SQL.banGet, [ip]); return r[0] ? { reason: r[0].reason, created_at: Number(r[0].created_at) } : null; }
  async banList(limit, offset) { return this.run<any[]>(SQL.banList, [limit, offset]).then(rs => rs.map(r => ({ ip: r.ip, reason: r.reason, created_at: Number(r.created_at) }))); }
  async banRemove(ip) { const r = await this.c.execute({ sql: SQL.banDel, args: [ip] }); return Number(r.rowsAffected) > 0; }
  async presenceUpsert(clientId, at) { await this.exec(SQL.presUp, [clientId, at]); }
  async presenceCount(cutoff) { const r = await this.run<any[]>(SQL.presCnt, [cutoff]); return Number(r[0]?.c ?? 0); }
  async rateHit(bucket, scope, windowStart) { const r = await this.run<any[]>(SQL.rateHit, [bucket, scope, windowStart]); return Number(r[0]?.count ?? 1); }
  async messageStats() { const r = await this.run<any[]>(SQL.stats, []); return { total: Number(r[0]?.total ?? 0), retained: Number(r[0]?.total ?? 0) - Number(r[0]?.del ?? 0) }; }
  async cleanupEvents(before) { return this.affected(SQL.delEvents, [before]); }
  async cleanupPresence(before) { return this.affected(SQL.delPres, [before]); }
  async cleanupRateLimits(before) { return this.affected(SQL.delRates, [before]); }
  async trimMessagesBelow(idFloor) { return this.affected(SQL.trimBelow, [idFloor]); }
  async deleteMessagesOlderThan(cutoff) { return this.affected(SQL.delOlder, [cutoff]); }
  private async affected(sql: string, args: unknown[]) { const r = await this.c.execute({ sql, args: args as any[] }); return Number(r.rowsAffected); }
}
```

PG 实现（`postgres.js`；`begin` 内传 `tx` 保证双写同事务；`?`→`$n` 转换一次完成）：

```ts
class PostgresRepo implements Repo {
  readonly provider = "postgres" as const;
  constructor(private sql: postgres.Sql<{}>) {}
  async bootstrap() { for (const d of ddlFor("postgres")) await this.sql.unsafe(d); }
  async close() { await this.sql.end(); }
  private toPgParams(sql: string, args: unknown[]) {
    let i = 0;
    const converted = sql.replace(/\?/g, () => `$${++i}`);
    return { sql: converted, args };
  }
  private async query<T>(sql: string, args: unknown[]): Promise<T[]> {
    const { sql: s, args: a } = this.toPgParams(sql, args);
    return (await this.sql.unsafe(s, a as any[])) as unknown as T[];
  }
  private async countAffected(sql: string, args: unknown[]) {
    const { sql: s, args: a } = this.toPgParams(sql, args);
    const r = await this.sql.unsafe(s, a as any[]);
    return r.count === undefined ? 0 : Number(r.count);
  }
  async sendMessageAndEvent(m) {
    return await this.sql.begin(async tx => {
      const [msg] = await tx.unsafe(`INSERT INTO messages (client_id, nick, text, created_at) VALUES ($1, $2, $3, $4) RETURNING id`, [m.client_id, m.nick, m.text, m.created_at]);
      const messageId = Number(msg.id);
      const payload = JSON.stringify({ id: String(messageId), client_id: m.client_id, nick: m.nick, text: m.text, created_at: m.created_at });
      const [ev] = await tx.unsafe(`INSERT INTO events (type, payload, created_at) VALUES ($1, $2, $3) RETURNING id`, ["message", payload, m.created_at]);
      return { messageId, eventId: Number(ev.id) };
    });
  }

  async publishEphemeralMessage(m) {
    return await this.sql.begin(async tx => {
      const [ev] = await tx.unsafe(`INSERT INTO events (type, payload, created_at) VALUES ($1, $2, $3) RETURNING id`, ["message", "", m.created_at]);
      const eventId = Number(ev.id);
      const payload = JSON.stringify({ id: `e${eventId}`, client_id: m.client_id, nick: m.nick, text: m.text, created_at: m.created_at });
      await tx.unsafe(`UPDATE events SET payload = $1 WHERE id = $2`, [payload, eventId]);
      return { eventId };
    });
  }
  // eventsSince/historyBefore/historySince/softDelete/… 用 this.query / 语义同上；
  // banUpsert：INSERT … ON CONFLICT (ip) DO UPDATE SET reason = EXCLUDED.reason, … RETURNING 1（无则新插）→ 用 countAffected
  // rateHit 等 RETURNING 行经 this.query 取 [0].count；close 前如有残留查询会抛错，用 this.sql.end({ timeout: 2 })
}
```

`createRepo` 工厂（URL 形态分流；本地无代理直连仅用于 dev/test 由配置层保证）：

```ts
export async function createRepo(provider: Provider, databaseUrl: string, authToken?: string): Promise<Repo> {
  if (provider === "sqlite") {
    return new SqliteRepo(createClient({ url: databaseUrl, authToken }));
  }
  const ssl = /[?&]sslmode=require/.test(databaseUrl) ? "require" : false;
  return new PostgresRepo(postgres(databaseUrl, { ssl, max: 1 }));
}
```

> 说明：PG 各方法体较长但为同一模板机械替换，务必以 `repo.test.ts` 五组用例为准跑绿；若有方言差异（如 `RETURNING`/`count` 字段名），以测试驱动修正。

- [ ] **步骤 4：运行测试验证通过（sqlite）**

运行：`bun test tests/integration/repo.test.ts`
预期：PASS（6 组）

- [ ] **步骤 5：若有可用 Postgres，同套用例再跑一遍（§8 双库矩阵）**

运行：`bun run test:pg`（先设 `DATABASE_URL=postgres://…`，测试用库会被 bootstrap 幂等建表）
预期：PASS（跳过说明：无 PG 环境时该步记录"待部署环境验证"）

- [ ] **步骤 6：Commit**

```bash
git add src/lib/ddl.ts src/lib/repo.ts tests/helpers.ts tests/integration/repo.test.ts
git commit -m "feat: portable DDL + dual-driver repo with transactional double-write (T2)"
```

---

## 任务 3：安全 / 校验 / 限流纯库

**文件：**

- 创建：`src/lib/security.ts`、`src/lib/validate.ts`、`src/lib/limits.ts`
- 测试：`tests/unit/security.test.ts`、`tests/unit/validate.test.ts`、`tests/unit/limits.test.ts`

- [ ] **步骤 1：写安全测试（先红）**

`tests/unit/security.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { normalizeIp, clientIpFromHeaders, normalizeOrigin, parseOriginList, classifyOrigin, signToken, verifyToken } from "../../src/lib/security";

describe("IP", () => {
  test("normalizeIp：trim/小写/非法返回 null", () => {
    expect(normalizeIp(" 1.2.3.4 ")).toBe("1.2.3.4");
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("::ffff:1.2.3.4");
    expect(normalizeIp("not-an-ip")).toBeNull();
    expect(normalizeIp("")).toBeNull();
  });
  test("clientIpFromHeaders：取 x-forwarded-for 首跳，缺失回退", () => {
    expect(clientIpFromHeaders({ "x-forwarded-for": "9.8.7.6, 10.0.0.1" }, "127.0.0.1")).toBe("9.8.7.6");
    expect(clientIpFromHeaders({}, "127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("Origin 白名单", () => {
  test("normalizeOrigin/parseOriginList：去尾斜杠、小写", () => {
    expect(parseOriginList("HTTPS://A.com/, https://b.com")).toEqual(["https://a.com", "https://b.com"]);
  });
  test("classifyOrigin：开放模式 / 白名单 fail-closed / 无 Origin", () => {
    const none: string[] = [];
    expect(classifyOrigin("https://evil.com", none, false).mode).toBe("open");
    const allowed = ["https://a.com", "http://localhost:3000"];
    expect(classifyOrigin("https://a.com", allowed, false)).toEqual({ mode: "allowed", origin: "https://a.com" });
    expect(classifyOrigin("https://evil.com", allowed, false).mode).toBe("denied");
    expect(classifyOrigin(undefined, allowed, false).mode).toBe("no_origin");
    expect(classifyOrigin(undefined, allowed, true)).toEqual({ mode: "denied", code: "missing_origin" });
    expect(classifyOrigin(undefined, none, true).mode).toBe("open");
  });
});

describe("HMAC 会话 Cookie", () => {
  const secret = "very-secret";
  test("sign+verify 往返；篡改/过期/换密钥均拒绝", () => {
    const token = signToken({ sub: "admin", exp: Date.now() + 60_000 }, secret);
    expect(verifyToken(token, secret)).toMatchObject({ sub: "admin" });
    expect(verifyToken(token.slice(0, -2) + "xx", secret)).toBeNull();
    expect(verifyToken(signToken({ sub: "admin", exp: Date.now() - 1 }, secret), secret)).toBeNull();
    expect(verifyToken(signToken({ sub: "admin", exp: Date.now() + 60_000 }, "other"))).toBeNull();
    expect(verifyToken("garbage", secret)).toBeNull();
  });
});
```

`tests/unit/validate.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { sanitizeText, validUuid, validateMessageBody } from "../../src/lib/validate";

const cfg = { nickMax: 24, textMax: 1000, bannedWords: ["赌博", "spam"] } as const;

describe("validateMessageBody", () => {
  test("合法消息通过；返回清洗后字段", () => {
    expect(validateMessageBody(cfg, { client_id: "11111111-2222-4333-8444-555555555555", nick: " 甲 ", text: "你好世界" })).toEqual({ ok: true, nick: "甲", text: "你好世界" });
  });
  test("uuid 非法 / 昵称超长 / 文本超长 / 禁词（子串）各自失败", () => {
    expect(validateMessageBody(cfg, { client_id: "nope", nick: "甲", text: "hi" }).code).toBe("invalid_uuid");
    expect(validateMessageBody(cfg, { client_id: "11111111-2222-4333-8444-555555555555", nick: "x".repeat(25), text: "hi" }).code).toBe("nick_too_long");
    expect(validateMessageBody(cfg, { client_id: "11111111-2222-4333-8444-555555555555", nick: "甲", text: "x".repeat(1001) }).code).toBe("text_too_long");
    expect(validateMessageBody(cfg, { client_id: "11111111-2222-4333-8444-555555555555", nick: "甲", text: "阳光大赌博场" }).code).toBe("banned_word");
    expect(validateMessageBody(cfg, { client_id: "11111111-2222-4333-8444-555555555555", nick: "", text: "hi" }).code).toBe("nick_empty");
    expect(validateMessageBody(cfg, { client_id: "11111111-2222-4333-8444-555555555555", nick: "甲", text: "  " }).code).toBe("text_empty");
  });
  test("sanitizeText 剥离控制字符；validUuid 大小写不敏感", () => {
    expect(sanitizeText("a\u0000b\u0007c")).toBe("abc");
    expect(validUuid("11111111-2222-4333-8444-555555555555")).toBe(true);
    expect(validUuid("11111111-2222-4333-8444-55555555555Z")).toBe(false);
  });
});
```

`tests/unit/limits.test.ts`：用假 repo 断言窗口对齐与 retry_after：

```ts
import { describe, expect, test } from "bun:test";
import { rateCheck } from "../../src/lib/limits";

function fakeRate(seq: number[]) {
  let i = 0;
  return { rateHit: async () => seq[Math.min(i++, seq.length - 1)] };
}
const now = 60_500; // 对齐后窗口起点 60_000

describe("rateCheck", () => {
  test("未超限 allowed；第 limit+1 次拒绝并给 retry_after_ms", async () => {
    const repo = fakeRate([1, 2, 3]);
    expect(await rateCheck(repo as any, "msg", "9.9.9.9", 2, now)).toEqual({ allowed: true, count: 1 });
    expect(await rateCheck(repo as any, "msg", "9.9.9.9", 2, now)).toEqual({ allowed: true, count: 2 });
    const r = await rateCheck(repo as any, "msg", "9.9.9.9", 2, now);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBe(59_500); // 60000+60000-60500
  });
  test("窗口按 60s 对齐传给 rateHit", async () => {
    let seen = 0;
    const repo = { rateHit: async (_b: string, _s: string, ws: number) => { seen = ws; return 1; } };
    await rateCheck(repo as any, "stream", "1.1.1.1", 5, 61_234);
    expect(seen).toBe(60_000);
  });
});
```

- [ ] **步骤 2：运行三组测试确认失败**

运行：`bun test tests/unit/security.test.ts tests/unit/validate.test.ts tests/unit/limits.test.ts`
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现三个纯库**

`src/lib/security.ts`：

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

export function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v || (v.includes(":") && !IPV6.test(v)) || (!v.includes(":") && !IPV4.test(v))) return null;
  return v.includes(":") ? v.toLowerCase() : v;
}

export function clientIpFromHeaders(headers: Record<string, string | undefined>, fallback: string): string {
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
export function classifyOrigin(origin: string | undefined, allowed: string[], requireOrigin: boolean): OriginClass {
  if (allowed.length === 0) return { mode: "open" };
  if (!origin) return requireOrigin ? { mode: "denied", code: "missing_origin" } : { mode: "no_origin" };
  const o = normalizeOrigin(origin);
  return allowed.includes(o) ? { mode: "allowed", origin: o } : { mode: "denied", code: "origin_not_allowed" };
}

const b64url = (buf: Buffer) => buf.toString("base64url");
const sha = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest();

export function signToken(payload: Record<string, unknown>, secret: string): string {
  const data = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${data}.${b64url(sha(secret, data))}`;
}
export function verifyToken(token: string | undefined, secret: string): Record<string, unknown> | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const expected = sha(secret, data);
    const got = Buffer.from(sig, "base64url");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as Record<string, unknown>;
    const exp = Number(payload.exp ?? 0);
    if (!exp || exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
```

`src/lib/validate.ts`：

```ts
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validUuid = (s: string) => UUID_RE.test(s);

export function sanitizeText(s: string): string {
  // 剥离控制字符（保留常见可见文本；SSE 的 \n 会被事件 data 行语义化，前端自处理）
  return s.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

export type MsgErr =
  | { ok: false; code: "invalid_uuid" | "nick_empty" | "nick_too_long" | "text_empty" | "text_too_long" | "banned_word"; field: string; message: string }
  | { ok: true; nick: string; text: string };

export function validateMessageBody(
  cfg: { nickMax: number; textMax: number; bannedWords: string[] },
  body: unknown,
): MsgErr {
  const b = (body ?? {}) as Record<string, unknown>;
  const client_id = typeof b.client_id === "string" ? b.client_id : "";
  if (!validUuid(client_id)) return { ok: false, code: "invalid_uuid", field: "client_id", message: "client_id 必须是合法 UUID" };
  const nick = typeof b.nick === "string" ? sanitizeText(b.nick) : "";
  const text = typeof b.text === "string" ? sanitizeText(b.text) : "";
  if (!nick) return { ok: false, code: "nick_empty", field: "nick", message: "昵称不能为空" };
  if (nick.length > cfg.nickMax) return { ok: false, code: "nick_too_long", field: "nick", message: `昵称最长 ${cfg.nickMax} 字` };
  if (!text) return { ok: false, code: "text_empty", field: "text", message: "内容不能为空" };
  if (text.length > cfg.textMax) return { ok: false, code: "text_too_long", field: "text", message: `内容最长 ${cfg.textMax} 字` };
  const lower = text.toLowerCase();
  const hit = cfg.bannedWords.find(w => w && lower.includes(w.toLowerCase()));
  if (hit) return { ok: false, code: "banned_word", field: "text", message: "内容含违禁词" };
  return { ok: true, nick, text };
}
```

`src/lib/limits.ts`：

```ts
export interface RateSink { rateHit(bucket: string, scope: string, windowStart: number): Promise<number> }

export async function rateCheck(
  repo: RateSink, bucket: string, scope: string, limitPerMin: number, now: number = Date.now(),
): Promise<{ allowed: boolean; count: number; retryAfterMs: number }> {
  const windowMs = 60_000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const count = await repo.rateHit(bucket, scope, windowStart);
  const allowed = count <= limitPerMin;
  return { allowed, count, retryAfterMs: windowStart + windowMs - now };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test tests/unit/security.test.ts tests/unit/validate.test.ts tests/unit/limits.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/lib/security.ts src/lib/validate.ts src/lib/limits.ts tests/unit/*.test.ts
git commit -m "feat: security/validate/rate-limit pure libs (T3)"
```

---

## 任务 4：历史保留策略 + SSE 流控制器（纯逻辑 + 假 repo）

**文件：**

- 创建：`src/lib/history.ts`、`src/lib/stream.ts`
- 测试：`tests/unit/history.test.ts`、`tests/unit/stream.test.ts`

- [ ] **步骤 1：写 history 测试（先红）**

`tests/unit/history.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { decideHistory, RETENTION_LADDER_DAYS } from "../../src/lib/history";

const cfg = { retentionDays: 90, maxRows: 1000 };

describe("decideHistory", () => {
  test("远低于上限 → full 且保留配置天数", () => {
    expect(decideHistory({ retained: 100 }, cfg)).toEqual({ mode: "full", retentionDays: 90 });
  });
  test("随行数增长逐级收缩：0.5→90…；阶梯常量正确", () => {
    expect(RETENTION_LADDER_DAYS).toEqual([90, 30, 10, 3, 1]);
    expect(decideHistory({ retained: 600 }, cfg).retentionDays).toBe(30);  // ≥50%
    expect(decideHistory({ retained: 800 }, cfg).retentionDays).toBe(10);  // ≥70%
    expect(decideHistory({ retained: 900 }, cfg).retentionDays).toBe(3);   // ≥85%
    expect(decideHistory({ retained: 960 }, cfg).retentionDays).toBe(1);   // ≥95%
  });
  test("触顶 → ephemeral", () => {
    expect(decideHistory({ retained: 1000 }, cfg)).toEqual({ mode: "ephemeral", retentionDays: 1 });
    expect(decideHistory({ retained: 1200 }, cfg).mode).toBe("ephemeral");
  });
  test("degraded_retention 标记出现在天数已降时", () => {
    const r = decideHistory({ retained: 600 }, cfg);
    expect(r.mode).toBe("degraded_retention");
    expect(decideHistory({ retained: 100 }, cfg).mode).toBe("full");
  });
});
```

`tests/unit/stream.test.ts`（假 `StreamRepo`，断言：消息广播、presence 变化才推、开流禁言提示、游标落后自动重置续传）：

```ts
import { describe, expect, test } from "bun:test";
import { runStream } from "../../src/lib/stream";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function fakeRepo(over: Record<string, any> = {}) {
  const events: any[] = over.events ?? [];
  const state = { since: 0, upserts: 0, counts: 0, maxId: over.maxId ?? 0, ban: over.ban ?? null, seen: [] as string[] };
  return {
    state,
    repo: {
      eventsSince: async (since: number) => events.filter(e => e.id > since).slice(0, 100),
      eventsMaxId: async () => state.maxId,
      presenceUpsert: async () => { state.upserts++; },
      presenceCount: async () => state.counts++ === 0 ? 1 : 1, // 固定 1 → 只在首推变化
      banGet: async () => state.ban,
    } as any,
  };
}

const cfg = { pollMs: 2, presenceUpsertMs: 2, presenceCountMs: 2, heartbeatMs: 1_000_000, presenceTtlMs: 45_000 } as any;

describe("runStream", () => {
  test("推送已有 events、presence 初值、并前进游标", async () => {
    const f = fakeRepo({ events: [{ id: 1, type: "message", payload: JSON.stringify({ id: 99 }), created_at: 1 }] });
    const out: [string, unknown][] = [];
    const ctrl = runStream({ repo: f.repo, cfg, clientId: "c1", emit: (t, d) => out.push([t, d]) });
    await sleep(10);
    ctrl.stop();
    const types = out.map(o => o[0]);
    expect(types).toContain("message");
    expect(types).toContain("presence");
    expect(f.state.upserts).toBeGreaterThan(0);
  });

  test("presence 计数变化才广播（两次计数相同只推一次）", async () => {
    let online = 1;
    const f = fakeRepo();
    f.repo.presenceCount = async () => online;
    const out: [string, unknown][] = [];
    const ctrl = runStream({ repo: f.repo, cfg, clientId: "c1", emit: (t, d) => out.push([t, d]) });
    await sleep(8);
    online = 2;
    await sleep(8);
    ctrl.stop();
    const pres = out.filter(o => o[0] === "presence");
    expect(pres.length).toBe(2);
    expect((pres[1][1] as any).online).toBe(2);
  });

  test("命中禁言：开流先发 ban 提示（流不关闭）", async () => {
    const f = fakeRepo({ ban: { reason: "spam" } });
    const out: [string, unknown][] = [];
    const ctrl = runStream({ repo: f.repo, cfg: { ...cfg, ip: "9.9.9.9" }, clientId: "c1", emit: (t, d) => out.push([t, d]) });
    await sleep(6);
    ctrl.stop();
    expect(out[0]).toEqual(["ban", { reason: "spam" }]);
  });

  test("游标落后（events 已清理）→ 重置到 maxId 后继续收到新事件", async () => {
    const f = fakeRepo({ maxId: 50 });
    const out: [string, unknown][] = [];
    // 场景：cursor=100，但 events 只保留到 50（已清理）→ 空转检测后重置为 50，随后新事件 101 到达
    f.repo.eventsSince = async (since: number) => {
      if (since >= 100) return [];
      if (since >= 50) return [{ id: 101, type: "message", payload: JSON.stringify({ id: "101", text: "new" }), created_at: 1 }];
      return [];
    };
    const ctrl = runStream({ repo: f.repo, cfg, clientId: "c1", since: 100, emit: (t, d) => out.push([t, d]) });
    await sleep(8);
    ctrl.stop();
    expect(out.some(o => o[0] === "message" && (o[1] as any).id === "101")).toBe(true); // 重置后 101 被推
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`bun test tests/unit/history.test.ts tests/unit/stream.test.ts`
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现 history.ts 与 stream.ts**

`src/lib/history.ts`：

```ts
export type HistoryMode = "full" | "degraded_retention" | "ephemeral";
export const RETENTION_LADDER_DAYS = [90, 30, 10, 3, 1];
const DAY_MS = 86_400_000;
// 行数占比阈值 → 收缩后保留天数（规格 §7.2：90→30→10→3→1）
const STEPS: [number, number][] = [[1, 1], [0.95, 3], [0.85, 10], [0.7, 30], [0.5, 90]]; // [触顶比例下限, 该档天数]

export function decideHistory(
  stats: { retained: number },
  cfg: { retentionDays: number; maxRows: number },
): { mode: HistoryMode; retentionDays: number } {
  const max = cfg.maxRows;
  if (max <= 0 || stats.retained >= max) return { mode: "ephemeral", retentionDays: 1 };
  const ratio = stats.retained / max;
  let days = cfg.retentionDays;
  for (const [threshold, d] of STEPS) if (ratio >= threshold) days = Math.min(days, d);
  if (days === cfg.retentionDays) return { mode: "full", retentionDays: days };
  return { mode: "degraded_retention", retentionDays: days };
}

export interface HistoryState { writeCount: number; mode: HistoryMode; retentionDays: number; noticesSent: { [k in HistoryMode]?: number } }

export function newHistoryState(): HistoryState { return { writeCount: 0, mode: "full", retentionDays: 90, noticesSent: {} }; }

export interface HistoryDeps {
  repo: {
    messageStats(): Promise<{ total: number; retained: number }>;
    cleanupEvents(before: number): Promise<number>;
    cleanupPresence(before: number): Promise<number>;
    cleanupRateLimits(before: number): Promise<number>;
    trimMessagesBelow(idFloor: number): Promise<number>;
    deleteMessagesOlderThan(cutoff: number): Promise<number>;
    historyBefore(before: number, limit: number): Promise<{ id: number }[]>;
  };
  cfg: { maxRows: number; retentionDays: number; presenceTtlMs: number; eventsTtlMs: number; maintenanceEvery: number };
}

/**
 * 维护入口：每 maintenanceEvery 次写调用一次。
 * 顺序：清过期(events/presence/rate_limits) → 按当前档天数删过期消息 → 若仍超行数则裁剪最旧 → 重算档位。
 * 返回新档位与清理量；由调用方决定是否广播 notice（跨实例各自重算、一致收敛）。
 */
export async function performMaintenance(deps: HistoryDeps, now = Date.now()): Promise<{ mode: HistoryMode; retentionDays: number; deleted: number }> {
  const { repo, cfg } = deps;
  await repo.cleanupEvents(now - cfg.eventsTtlMs);
  await repo.cleanupPresence(now - cfg.presenceTtlMs * 3);
  await repo.cleanupRateLimits(now - 2 * 3_600_000);
  let { retained } = await repo.messageStats();
  let days = cfg.retentionDays;
  let deleted = 0;
  // 先按档位天数裁剪（决定档位时用裁剪前的 retained）
  const dec = decideHistory({ retained }, cfg);
  days = Math.min(days, dec.retentionDays);
  deleted += await repo.deleteMessagesOlderThan(now - days * DAY_MS);
  ({ retained } = await repo.messageStats());
  if (retained >= cfg.maxRows && cfg.maxRows > 0) {
    // 保留最新 maxRows 条：取第 maxRows 新的 id 作为裁剪下限
    const rows = await repo.historyBefore(Number.MAX_SAFE_INTEGER, cfg.maxRows);
    if (rows.length >= cfg.maxRows) {
      const floor = rows[rows.length - 1].id;
      deleted += await repo.trimMessagesBelow(floor);
      ({ retained } = await repo.messageStats());
    }
  }
  const final = decideHistory({ retained }, cfg);
  return { mode: final.mode, retentionDays: final.retentionDays, deleted };
}
```

`src/lib/stream.ts` —— 控制器（规格 §3 内部循环 1–6 落地）：

```ts
import type { EventRow } from "./repo";

export interface StreamRepo {
  eventsSince(since: number, limit: number): Promise<EventRow[]>;
  eventsMaxId(): Promise<number>;
  presenceUpsert(clientId: string, at: number): Promise<void>;
  presenceCount(cutoff: number): Promise<number>;
  banGet(ip: string): Promise<{ reason: string } | null>;
}

export interface StreamCfg {
  pollMs: number; presenceUpsertMs: number; presenceCountMs: number;
  heartbeatMs: number; presenceTtlMs: number; ip?: string;
}
export interface StreamOpts {
  repo: StreamRepo;
  cfg: StreamCfg;
  clientId: string;
  since: number;
  emit: (type: string, data: unknown) => void;
  emitComment: (text: string) => void;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** 返回控制柄：start() 进入循环（异步），stop() 请求停止。 */
export function runStream(o: StreamOpts): { stop: () => void } {
  let stopped = false;
  let since = o.since;
  let lastOnline: number | null = null;
  let lastSent = Date.now();
  let lastUpsert = 0;
  let lastCount = 0;

  const tickPoll = async () => {
    let rows = await o.repo.eventsSince(since, 100);
    if (rows.length === 0 && since > 0) {
      // 游标回退（规格 §5「流与游标语义」）：events 已清理 → 重置到当前 max
      const maxId = await o.repo.eventsMaxId();
      if (since > maxId) since = Math.max(maxId, 0);
      rows = await o.repo.eventsSince(since, 100);
    }
    for (const e of rows) {
      since = e.id;
      let data: unknown = {};
      try { data = JSON.parse(e.payload); } catch { data = { raw: e.payload }; }
      o.emit(e.type, data);
    }
    lastSent = Date.now();
  };
  // 时间门控：upsert/COUNT 按各自节拍（cfg.presenceUpsertMs / countMs）执行，轮询 tick 只负责 pollMs
  const tickUpsert = async () => {
    const now = Date.now();
    if (now - lastUpsert < o.cfg.presenceUpsertMs) return;
    lastUpsert = now;
    await o.repo.presenceUpsert(o.clientId, now);
  };
  const tickCount = async () => {
    const now = Date.now();
    if (now - lastCount < o.cfg.presenceCountMs) return;
    lastCount = now;
    const online = await o.repo.presenceCount(now - o.cfg.presenceTtlMs);
    if (online !== lastOnline) { lastOnline = online; o.emit("presence", { online }); }
  };

  (async () => {
    if (o.cfg.ip) {
      const ban = await o.repo.banGet(o.cfg.ip);
      if (ban) o.emit("ban", { reason: ban.reason }); // D5：禁言提示，流保持
    }
    await tickUpsert();
    await tickCount();
    lastUpsert = Date.now(); // 初始心跳记时，避免下一 tick 立即重复
    lastCount = lastUpsert;
    while (!stopped) {
      const cycleStart = Date.now();
      await tickPoll();
      if (stopped) break;
      await tickUpsert();
      if (Date.now() - lastSent >= o.cfg.heartbeatMs) { o.emitComment("ping"); lastSent = Date.now(); }
      await tickCount();
      const elapsed = Date.now() - cycleStart;
      await sleep(Math.max(o.cfg.pollMs - elapsed, 0)); // 对齐 tick，防 async 堆积
    }
  })().catch(err => {
    o.emit("error", { code: "db_unavailable", message: String(err) });
    stopped = true;
  });

  return { stop: () => { stopped = true; } };
}
```

> 说明：`tickCount` 的实现测试期望"相同只推一次"，真实 repo 下 online 从 0→N 自然变化；心跳归 `emitComment`。错误一律推 `error` 事件后停止（HTTP 层视需要断开）。

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test tests/unit/history.test.ts tests/unit/stream.test.ts`
预期：PASS

> 若某断言时序不稳：调大对应 `sleep`（10→30ms）再跑，勿改断言语义。

- [ ] **步骤 5：Commit**

```bash
git add src/lib/history.ts src/lib/stream.ts tests/unit/history.test.ts tests/unit/stream.test.ts
git commit -m "feat: retention policy + SSE stream controller (T4)"
```

---

## 任务 5：chat 路由（meta / messages / POST）与 app 装配

**文件：**

- 创建：`src/lib/http.ts`、`src/routes/chat.ts`、`src/app.ts`
- 修改：`tests/helpers.ts`（追加 app 工厂）
- 测试：`tests/integration/app.chat.test.ts`

- [ ] **步骤 1：写 chat 集成测试（先红；经 `app.request` 全链路）**

`tests/helpers.ts` 追加：

```ts
import { Hono } from "hono";
import { createApp } from "../src/app";
import type { AppConfig } from "../src/lib/config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function testCfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    env: "test", port: 0, dbProvider: "sqlite",
    databaseUrl: `file:${join(mkdtempSync(join(tmpdir(), "wl-app-")), "t.db")}`,
    migrateOnBoot: true, adminSecret: "test-secret", devIp: "127.0.0.1",
    nickMax: 24, textMax: 1000, bannedWords: ["赌博"],
    retentionDays: 90, maxRows: 500_000, backfillMax: 0,
    presenceTtlMs: 45_000, pollMs: 10, presenceUpsertMs: 10, presenceCountMs: 10,
    heartbeatMs: 15_000, eventsTtlMs: 3_600_000, maintenanceEvery: 100,
    rate: { msgPerMin: 10, streamPerMin: 20, loginPerMin: 5, windowMs: 60_000 },
    allowedOrigins: [], requireOrigin: false, sessionDays: 7, cookieName: "wl_admin",
    ...over,
  };
}

export async function makeApp(over: Partial<AppConfig> = {}) {
  const cfg = testCfg(over);
  const dir = join(tmpdir(), `wl-app-${Math.random().toString(36).slice(2)}`);
  // sqlite 文件放在可清理目录
  const { createRepo } = await import("../src/lib/repo");
  const repo = await createRepo("sqlite", `file:${join(dir, "t.db")}`);
  await repo.bootstrap();
  const app = createApp(cfg, repo);
  return { cfg, app, repo, cleanup: async () => { await repo.close(); rmSync(dir, { recursive: true, force: true }); } };
}

export const UUID = "11111111-2222-4333-8444-555555555555";
```

`tests/integration/app.chat.test.ts`：

```ts
import { describe, expect, test, afterEach } from "bun:test";
import { makeApp, UUID } from "../helpers";

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const boot = async (over: any = {}) => { const h = await makeApp(over); cleanups.push(h.cleanup); return h; };

describe("chat 公开端点", () => {
  test("meta：限额/presence/client_ip，无 DB 也可用", async () => {
    const { app } = await boot();
    const res = await app.request("/api/meta", { headers: { "x-forwarded-for": "9.9.9.9" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limits).toEqual({ nick_max: 24, text_max: 1000, retention_days: 90 });
    expect(body.presence.ttl_s).toBe(45);
    expect(body.client_ip).toBe("9.9.9.9");
  });

  test("POST 消息 → 201；历史回溯 before/since 视图一致", async () => {
    const { app } = await boot();
    const post = async (i: number) => {
      const res = await app.request("/api/messages", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4" }, body: JSON.stringify({ client_id: UUID, nick: "甲", text: `第${i}条` }) });
      expect(res.status).toBe(201);
      return (await res.json()) as { id: string; created_at: string };
    };
    const a = await post(1); const b = await post(2);
    const latest = await app.request("/api/messages?limit=10");
    const lb = await latest.json();
    expect(lb.messages[0]).toMatchObject({ id: b.id, nick: "甲", text: "第2条" });
    expect(typeof lb.messages[0].created_at).toBe("string"); // ISO
    const gap = await app.request(`/api/messages?since=${a.id}`);
    const gb = await gap.json();
    expect(gb.messages.map((m: any) => m.id)).toEqual([b.id]);
  });

  test("错误信封：400 禁词 / 400 uuid / 429 限流（含 retry_after_ms）", async () => {
    const { app } = await boot({ rate: { msgPerMin: 2, streamPerMin: 20, loginPerMin: 5, windowMs: 60_000 } });
    const send = (text: string) => app.request("/api/messages", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "5.6.7.8" }, body: JSON.stringify({ client_id: UUID, nick: "甲", text }) });
    let res = await send("阳光大赌博场");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("banned_word");
    res = await send("正常消息");
    expect(res.status).toBe(201);
    res = await send("第二条"); expect(res.status).toBe(201);
    res = await send("第三条超限");
    expect(res.status).toBe(429);
    const err = await res.json();
    expect(err.error.code).toBe("rate_limited");
    expect(err.error.retry_after_ms).toBeGreaterThan(0);
    const bad = await app.request("/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: "bad", nick: "甲", text: "x" }) });
    expect((await bad.json()).error.code).toBe("invalid_uuid");
  });

  test("禁言：命中 bans 的 IP POST → 403 banned（含 reason）；未被禁 IP 正常", async () => {
    const { app, repo } = await boot();
    await repo.banUpsert("8.8.8.8", "spam", "admin", Date.now());
    const res = await app.request("/api/messages", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "8.8.8.8" }, body: JSON.stringify({ client_id: UUID, nick: "甲", text: "hi" }) });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatchObject({ code: "banned", reason: "spam" });
  });

  test("backfill 深度：HISTORY_MAX_BACKFILL>0 时 beyond 返回空并带 mode", async () => {
    const { app } = await boot({ backfillMax: 2 });
    for (let i = 0; i < 3; i++) {
      await app.request("/api/messages", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "3.3.3.3" }, body: JSON.stringify({ client_id: UUID, nick: "n", text: `m${i}` }) });
    }
    const res = await app.request("/api/messages?limit=50");
    const body = await res.json();
    expect(body.messages.length).toBe(2); // 只回最近 2 条（新→旧）
    expect(body.mode).toBeDefined();
  });

  test("Origin 白名单 fail-closed + 开放模式回 ACAO *", async () => {
    const open = await boot();
    const r1 = await open.app.request("/api/meta", { headers: { origin: "https://any.com" } });
    expect(r1.headers.get("access-control-allow-origin")).toBe("*");
    const locked = await boot({ allowedOrigins: ["https://a.com"] });
    const ok = await locked.app.request("/api/meta", { headers: { origin: "https://a.com" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://a.com");
    const bad = await locked.app.request("/api/meta", { headers: { origin: "https://evil.com" } });
    expect(bad.status).toBe(403);
    expect((await bad.json()).error.code).toBe("origin_not_allowed");
    const none = await locked.app.request("/api/meta"); // 无 Origin 默认放行
    expect(none.status).toBe(200);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`bun test tests/integration/app.chat.test.ts`
预期：FAIL（`../src/app` 不存在等）

- [ ] **步骤 3：实现 http 助手与 chat 路由及 app 装配**

`src/lib/http.ts`：

```ts
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const codes = {
  invalid_body: "请求体缺失或不是 JSON",
  invalid_uuid: "client_id 必须是合法 UUID",
  invalid_cursor: "游标 id 必须是正整数",
  nick_empty: "昵称不能为空",
  nick_too_long: "昵称超长",
  text_empty: "内容不能为空",
  text_too_long: "内容超长",
  banned_word: "内容含违禁词",
  banned: "该 IP 已被禁言",
  rate_limited: "请求过于频繁",
  origin_not_allowed: "来源不被允许",
  missing_origin: "缺少 Origin 来源",
  unauthorized: "未登录或会话失效",
  invalid_secret: "管理口令错误",
  not_found: "资源不存在",
  db_unavailable: "数据库暂不可用",
} as const;
export type ErrCode = keyof typeof codes;

export function jsonError(c: Context, status: ContentfulStatusCode, code: ErrCode, extra?: { message?: string; retry_after_ms?: number; reason?: string }) {
  return c.json({ error: { code, message: extra?.message ?? codes[code], ...(extra?.retry_after_ms !== undefined ? { retry_after_ms: extra.retry_after_ms } : {}), ...(extra?.reason !== undefined ? { reason: extra.reason } : {}) } }, status);
}

export async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  const ct = c.req.header("content-type") ?? "";
  if (!ct.includes("application/json")) return null;
  try { return await c.req.json(); } catch { return null; }
}

export function parseIdParam(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
```

`src/lib/http.ts` 之上、`src/routes/chat.ts`（meta/messages/POST；stream 在 T6 追加）：

```ts
import type { Hono } from "hono";
import type { AppConfig } from "../lib/config";
import type { Repo } from "../lib/repo";
import { clientIpFromHeaders } from "../lib/security";
import { validateMessageBody, validUuid } from "../lib/validate";
import { rateCheck } from "../lib/limits";
import { parseIdParam, jsonError, readJson } from "../lib/http";

export interface ChatDeps {
  cfg: AppConfig;
  repo: Repo;
  history: { mode: "full" | "degraded_retention" | "ephemeral"; retentionDays: number };
  /** 每次写后由调用方调用的维护触发；返回最新档位 */
  maintain?: (now?: number) => Promise<{ mode: any; retentionDays: number }>;
}

const iso = (ms: number) => new Date(ms).toISOString();
const fmtMessage = (m: any) => ({
  id: String(m.id), client_id: m.client_id, nick: m.nick,
  text: m.text, deleted: m.deleted, created_at: iso(m.created_at),
});

export function registerChat(app: Hono, d: ChatDeps) {
  const { cfg, repo } = d;

  app.get("/api/meta", c => {
    const ip = clientIpFromHeaders(c.req.header(), cfg.devIp);
    return c.json({
      limits: { nick_max: cfg.nickMax, text_max: cfg.textMax, retention_days: d.history.retentionDays },
      presence: { ttl_s: Math.floor(cfg.presenceTtlMs / 1000) },
      client_ip: ip,
    });
  });

  app.get("/api/messages", async c => {
    const before = parseIdParam(c.req.query("before"));
    const since = parseIdParam(c.req.query("since"));
    if (before !== null && since !== null) return jsonError(c, 400, "invalid_body", { message: "before 与 since 不可同时使用" });
    const rawLimit = c.req.query("limit");
    const limit = Math.min(Math.max(Number(rawLimit ?? 50) || 50, 1), 200);
    if (d.history.mode === "ephemeral") return c.json({ messages: [], mode: "ephemeral" });
    let rows: any[];
    if (before !== null) rows = await repo.historyBefore(before, limit);
    else if (since !== null) rows = await repo.historySince(since, limit);
    else rows = await repo.historyBefore(Number.MAX_SAFE_INTEGER, limit);
    let cutoff: number | null = null;
    if (cfg.backfillMax > 0) {
      const keep = await repo.historyBefore(Number.MAX_SAFE_INTEGER, cfg.backfillMax);
      cutoff = keep.length >= cfg.backfillMax ? keep[keep.length - 1].id : 0;
    }
    const filtered = cutoff === null ? rows : rows.filter(m => m.id >= cutoff);
    return c.json({ messages: filtered.map(fmtMessage), mode: d.history.mode });
  });

  app.post("/api/messages", async c => {
    const ip = clientIpFromHeaders(c.req.header(), cfg.devIp);
    try {
      const ban = await repo.banGet(ip);
      if (ban) return jsonError(c, 403, "banned", { reason: ban.reason }); // D5 禁言：禁发不禁看
      const rl = await rateCheck(repo, "msg", ip, cfg.rate.msgPerMin);
      if (!rl.allowed) return jsonError(c, 429, "rate_limited", { retry_after_ms: rl.retryAfterMs });
    } catch {
      return jsonError(c, 503, "db_unavailable");
    }
    const body = await readJson(c);
    if (!body) return jsonError(c, 400, "invalid_body");
    const v = validateMessageBody(cfg, body);
    if (!v.ok) return jsonError(c, 400, v.code);
    const msg = { client_id: body.client_id as string, nick: v.nick, text: v.text, created_at: Date.now() };
    try {
      if (d.history.mode === "ephemeral") {
        // §7.2 仅实时：只写 events 广播（payload id 前缀 e 避开 messages.id）
        const { eventId } = await repo.publishEphemeralMessage(msg);
        await d.maintain?.();
        return c.json({ id: `e${eventId}`, created_at: iso(msg.created_at) }, 201);
      }
      const { messageId } = await repo.sendMessageAndEvent(msg);
      await d.maintain?.(); // 每 maintenanceEvery 次写触发清理/档位评估（内部计数判断）
      return c.json({ id: String(messageId), created_at: iso(msg.created_at) }, 201);
    } catch {
      return jsonError(c, 503, "db_unavailable");
    }
  });
}
```

- [ ] **步骤 3.5：追加降级/notice 用例（追加到步骤 1 的测试文件）**

```ts
test("维护触发：接近 maxRows 广播 notice；到顶 → ephemeral 停写历史", async () => {
  const { app, repo } = await boot({ maxRows: 4, maintenanceEvery: 1 });
  const send = () => app.request("/api/messages", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "4.4.4.4" }, body: JSON.stringify({ client_id: UUID, nick: "n", text: "x" }) });
  for (let i = 0; i < 4; i++) { const r = await send(); expect(r.status).toBe(201); }
  const r5 = await send(); // 第 5 条：ephemeral，不落 messages、仅 events
  expect(r5.status).toBe(201);
  const hist = await (await app.request("/api/messages?limit=10")).json();
  expect(hist).toMatchObject({ messages: [], mode: "ephemeral" });
  const stats = await repo.messageStats();
  expect(stats.total).toBe(4);
  const evs = await repo.eventsSince(0, 100);
  expect(evs.some(e => e.type === "notice")).toBe(true); // history_mode 广播
  const msgEvs = evs.filter(e => e.type === "message");
  expect(JSON.parse(msgEvs[msgEvs.length - 1].payload).id.startsWith("e")).toBe(true);
});
```

> 用例依赖每次 POST 后触发 `maintain`（`maintenanceEvery: 1`）；默认 msg 限流 10/min，5 次发送不会触顶。

- [ ] **步骤 4：实现 app.ts（Origin 中间件 + 挂载 + 惰性 boot）**

`src/app.ts`：

```ts
import { Hono } from "hono";
import type { AppConfig } from "./lib/config";
import type { Repo } from "./lib/repo";
import { classifyOrigin } from "./lib/security";
import { jsonError } from "./lib/http";
import { registerChat } from "./routes/chat";
import { newHistoryState, performMaintenance } from "./lib/history";

export interface AppDeps { cfg: AppConfig; repo: Repo }

export function createApp(deps: AppDeps): Hono {
  const { cfg, repo } = deps;
  const history = newHistoryState();
  let booted: Promise<void> | null = null;
  const boot = () => (booted ??= (async () => { if (cfg.migrateOnBoot) await repo.bootstrap(); })());
  const app = new Hono();

  // 惰性 boot（Vercel 冷启动幂等）+ 每请求快路径
  app.use("*", async (c, next) => { await boot(); await next(); });

  // /api 中间件：Origin 闸口（§6.1）+ CORS 响应头
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    const cls = classifyOrigin(origin, cfg.allowedOrigins, cfg.requireOrigin);
    if (cls.mode === "open") {
      c.header("access-control-allow-origin", "*");
    } else if (cls.mode === "allowed") {
      c.header("access-control-allow-origin", cls.origin);
      c.header("vary", "Origin");
    } else if (cls.mode === "denied") {
      return jsonError(c, 403, cls.code);
    }
    if (c.req.method === "OPTIONS") {
      c.header("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
      c.header("access-control-allow-headers", "content-type");
      c.header("access-control-max-age", "86400");
      return c.body(null, 204);
    }
    await next();
  });

  registerChat(app, {
    cfg, repo, history,
    // §7.2 维护：每 maintenanceEvery 次写触发一次清理与档位评估；档位变化广播 notice
    maintain: async (now = Date.now()) => {
      history.writeCount += 1;
      if (history.writeCount % cfg.maintenanceEvery !== 0) return { mode: history.mode, retentionDays: history.retentionDays };
      const res = await performMaintenance({ repo, cfg }, now);
      if (res.mode !== history.mode || res.retentionDays !== history.retentionDays) {
        const prev = history.mode;
        history.mode = res.mode;
        history.retentionDays = res.retentionDays;
        if (prev !== res.mode) {
          await repo.insertEvent("notice", JSON.stringify({ kind: "history_mode", mode: res.mode, retention_days: res.retentionDays }), now).catch(() => {});
        }
      }
      return { mode: history.mode, retentionDays: history.retentionDays };
    },
  });
  // T7: registerAdmin(app, {cfg, repo}); T8: registerPages(app);
  return app;
}
```

> 提示：`app.use("*")` 里 `await boot()` 每请求判一次内存标志（`booted ??=`），代价可忽略。

- [ ] **步骤 5：运行测试验证通过**

运行：`bun test tests/integration/app.chat.test.ts`
预期：PASS。若 T2 期间发生过接口占位回退，先重跑 `bun test tests/integration/repo.test.ts` 确认后再进本任务。

- [ ] **步骤 6：Commit**

```bash
git add src/lib/http.ts src/routes/chat.ts src/app.ts tests/helpers.ts tests/integration/app.chat.test.ts
git commit -m "feat: chat routes (meta/messages/POST) + origin gate app assembly (T5)"
```

---

## 任务 6：SSE 事件流路由集成

**文件：**

- 修改：`src/routes/chat.ts`、`src/app.ts`、`tests/integration/app.chat.test.ts`

- [ ] **步骤 1：写 SSE 集成测试（先红）**

追加到 `tests/integration/app.chat.test.ts`（helpers 加 `readSse`）：

```ts
// tests/helpers.ts 追加：
export async function readSse(res: Response, waitFor: (type: string, data: any) => boolean, timeoutMs = 3000): Promise<{ type: string; data: any }[]> {
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
      const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const lines = block.split("\n");
      let type = "message";
      let data: any = null;
      for (const line of lines) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) data = JSON.parse(line.slice(5).trim());
      }
      if (data !== null) out.push({ type, data });
      if (waitFor(type, data)) { await reader.cancel().catch(() => {}); return out; }
    }
  }
  await reader.cancel().catch(() => {});
  return out;
}
```

```ts
test("SSE：开流收 presence 初值；POST 后经 events 广播收到 message；多客户端在线计 1（同 client_id）", async () => {
  const { app, repo } = await boot();
  const ctrl = new AbortController();
  const res = await app.request(`/api/stream?client_id=${UUID}`, { headers: { "x-forwarded-for": "1.1.1.1" }, signal: ctrl.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  // 另开一连接同 client_id → presence 仍 1 人
  const res2 = await app.request(`/api/stream?client_id=${UUID}`, { headers: { "x-forwarded-for": "2.2.2.2" } });
  const seen = await readSse(res, (type) => type === "presence", 2000);
  expect(seen.some(e => e.type === "presence")).toBe(true);
  await repo.presenceUpsert(UUID, Date.now()); // 保证至少 1
  const post = await app.request("/api/messages", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "1.1.1.1" }, body: JSON.stringify({ client_id: UUID, nick: "甲", text: "流广播" }) });
  expect(post.status).toBe(201);
  const got = await readSse(res, (type, data) => type === "message" && data.text === "流广播", 2000);
  expect(got.some(e => e.type === "message")).toBe(true);
  await res2.body?.cancel().catch(() => {});
  ctrl.abort();
});
```

> 说明：presence 断言只验证初值事件存在 + message 广播可达；精确"在线=1"由 repo.presenceCount 单测覆盖，避免时序脆弱。

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/integration/app.chat.test.ts`
预期：FAIL（`/api/stream` 404）

- [ ] **步骤 3：在 chat.ts 注册 stream 路由（hono streamSSE 包装 runStream）**

在 `registerChat` 内追加：

```ts
app.get("/api/stream", async c => {
  const ip = clientIpFromHeaders(c.req.header(), cfg.devIp);
  const sinceParam = c.req.query("since");
  const since = sinceParam && /^\d+$/.test(sinceParam) ? Number(sinceParam) : 0;
  const clientParam = c.req.query("client_id");
  const clientId = clientParam && validUuid(clientParam) ? clientParam : `anon-${crypto.randomUUID()}`;
  const { streamSSE } = await import("hono/streaming");
  c.header("cache-control", "no-cache");
  c.header("x-accel-buffering", "no");
  return streamSSE(c, async (stream) => {
    const ctrl = runStream({
      repo: d.repo, cfg, clientId, since, ip,
      emit: (type, data) => { stream.writeSSE({ event: type, data: JSON.stringify(data) }); },
      emitComment: () => { stream.write(": ping\n\n"); }, // SSE 注释行保活（非 data 帧，客户端忽略）
    });
    // 心跳已由 runStream 按 heartbeatMs 经 emitComment 发送注释行保活
    stream.onAbort(() => ctrl.stop());
    await stream.aborted; // 直到客户端断开
  });
});
```

> 对照 `runStream` 心跳：控制器在距上次发送超过 `heartbeatMs` 时发注释；`streamSSE` 的 `writeSSE` 自动包装 `data:` 行，`: ping` 经 `data: : ping` 亦保持连接。如出现格式问题，直接 `stream.write(": ping\n\n")`。

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test tests/integration/app.chat.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/routes/chat.ts src/app.ts tests/helpers.ts tests/integration/app.chat.test.ts
git commit -m "feat: SSE /api/stream with runStream controller (T6)"
```

---

## 任务 7：管理 JSON API 与会话

**文件：**

- 创建：`src/routes/admin.ts`
- 修改：`src/app.ts`
- 测试：`tests/integration/app.admin.test.ts`

- [ ] **步骤 1：写 admin 集成测试（先红；Cookie 携带）**

`tests/integration/app.admin.test.ts`：

```ts
import { describe, expect, test, afterEach } from "bun:test";
import { makeApp, UUID } from "../helpers";

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const boot = async (over: any = {}) => { const h = await makeApp(over); cleanups.push(h.cleanup); return h; };
const json = (body: unknown) => ({ "content-type": "application/json", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("admin API", () => {
  test("未登录访问 → 401；错误口令 → 401 invalid_secret；正确口令发 cookie", async () => {
    const { app } = await boot();
    let res = await app.request("/api/admin/stats");
    expect(res.status).toBe(401);
    res = await app.request("/api/admin/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "1.1.1.1" }, body: JSON.stringify({ secret: "wrong" }) });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("invalid_secret");
    res = await app.request("/api/admin/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "1.1.1.1" }, body: JSON.stringify({ secret: "test-secret" }) });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("wl_admin=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    // 用 cookie 访问
    res = await app.request("/api/admin/stats", { headers: { cookie: setCookie.split(";")[0] } });
    expect(res.status).toBe(200);
  });

  test("封禁流程：列表→新增→再次新增幂等→删除", async () => {
    const { app } = await boot();
    const login = await app.request("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: "test-secret" }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const auth = (extra: Record<string, string> = {}) => ({ cookie, ...extra });
    let res = await app.request("/api/admin/bans", { method: "POST", headers: auth(json({ ip: "6.6.6.6", reason: "刷屏" })) });
    expect(res.status).toBe(200);
    expect((await res.json()).created).toBe(true);
    res = await app.request("/api/admin/bans", { method: "POST", headers: auth(json({ ip: "6.6.6.6", reason: "再刷" })) });
    expect((await res.json()).created).toBe(false);
    const list = await (await app.request("/api/admin/bans", { headers: auth() })).json();
    expect(list.bans[0]).toMatchObject({ ip: "6.6.6.6", reason: "再刷" });
    res = await app.request("/api/admin/bans/6.6.6.6", { method: "DELETE", headers: auth() });
    expect(res.status).toBe(204);
    const after = await (await app.request("/api/admin/bans", { headers: auth() })).json();
    expect(after.bans).toHaveLength(0);
  });

  test("删消息：软删占位广播 delete 事件；不存在 → 404", async () => {
    const { app } = await boot();
    const post = await app.request("/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: UUID, nick: "n", text: "待删" }) });
    const { id } = await post.json();
    const login = await app.request("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: "test-secret" }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    let res = await app.request(`/api/admin/messages/${id}`, { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(204);
    const hist = await (await app.request("/api/messages?limit=10")).json();
    const row = hist.messages.find((m: any) => m.id === id);
    expect(row).toMatchObject({ deleted: true, text: null });
    res = await app.request(`/api/admin/messages/${id}`, { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(404);
  });

  test("stats：含 online / messages_total / history", async () => {
    const { app } = await boot();
    const login = await app.request("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: "test-secret" }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const stats = await (await app.request("/api/admin/stats", { headers: { cookie } })).json();
    expect(stats).toMatchObject({ messages_total: 0 });
    expect(typeof stats.online).toBe("number");
    expect(stats.history.mode).toBe("full");
  });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/integration/app.admin.test.ts`
预期：FAIL（404）

- [ ] **步骤 3：实现 admin 路由**

`src/routes/admin.ts`：

```ts
import type { Hono } from "hono";
import type { AppConfig } from "../lib/config";
import type { Repo } from "../lib/repo";
import type { HistoryState } from "../lib/history";
import { signToken, verifyToken, clientIpFromHeaders, normalizeIp } from "../lib/security";
import { rateCheck } from "../lib/limits";
import { jsonError, readJson, parseIdParam } from "../lib/http";

export interface AdminDeps {
  cfg: AppConfig; repo: Repo;
  history: HistoryState & { retentionDays: number };
  maintain: (now?: number) => Promise<{ mode: "full" | "degraded_retention" | "ephemeral"; retentionDays: number }>;
}

const COOKIE_FLAGS = "HttpOnly; SameSite=Lax; Path=/";
export function cookieHeader(cfg: AppConfig, token: string, maxAgeSec: number) {
  return `wl_admin=${token}; Max-Age=${maxAgeSec}; ${COOKIE_FLAGS}`;
}

export function registerAdmin(app: Hono, d: AdminDeps) {
  const { cfg, repo } = d;

  app.post("/api/admin/login", async c => {
    const ip = clientIpFromHeaders(c.req.header(), cfg.devIp);
    try {
      const rl = await rateCheck(repo, "login", ip, cfg.rate.loginPerMin);
      if (!rl.allowed) return jsonError(c, 429, "rate_limited", { retry_after_ms: rl.retryAfterMs });
    } catch { return jsonError(c, 503, "db_unavailable"); }
    const body = await readJson(c);
    const given = (body as any)?.secret;
    if (typeof given !== "string" || given.length === 0) return jsonError(c, 400, "invalid_body");
    if (given !== cfg.adminSecret) return jsonError(c, 401, "invalid_secret");
    const exp = Date.now() + cfg.sessionDays * 86_400_000;
    const token = signToken({ sub: "admin", exp }, cfg.adminSecret);
    c.header("set-cookie", cookieHeader(cfg, token, cfg.sessionDays * 86_400));
    return c.json({ ok: true });
  });

  const authed = async (c: any) => {
    const cookie = c.req.header("cookie") ?? "";
    const m = cookie.match(/(?:^|;\s*)wl_admin=([^;]+)/);
    if (!m) return null;
    const p = verifyToken(m[1], cfg.adminSecret);
    return p && p.sub === "admin" ? p : null;
  };
  const guard = async (c: any, next: any) => { const p = await authed(c); if (!p) return jsonError(c, 401, "unauthorized"); await next(); };

  app.post("/api/admin/logout", async c => {
    c.header("set-cookie", `wl_admin=; Max-Age=0; ${COOKIE_FLAGS}`);
    return c.json({ ok: true });
  });

  app.get("/api/admin/me", guard, c => c.json({ authed: true }));

  app.get("/api/admin/stats", guard, async c => {
    try {
      const stats = await repo.messageStats();
      const online = await repo.presenceCount(Date.now() - cfg.presenceTtlMs);
      const hist = await d.maintain(); // 借维护刷新档位
      return c.json({
        online,
        messages_total: stats.total,
        messages_retained: stats.retained,
        history: { mode: hist.mode, retention_days: hist.retentionDays, estimate_bytes: stats.retained * 400 },
      });
    } catch { return jsonError(c, 503, "db_unavailable"); }
  });

  app.get("/api/admin/bans", guard, async c => {
    const raw = Number(c.req.query("limit") ?? 200);
    const limit = Math.min(Math.max(Number.isFinite(raw) ? raw : 200, 1), 500);
    const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
    try { return c.json({ bans: await repo.banList(limit, offset) }); }
    catch { return jsonError(c, 503, "db_unavailable"); }
  });

  app.post("/api/admin/bans", guard, async c => {
    const body = await readJson(c);
    if (!body) return jsonError(c, 400, "invalid_body");
    const ip = normalizeIp(body.ip as string);
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : "";
    if (!ip) return jsonError(c, 400, "invalid_body", { message: "ip 不合法" });
    try {
      const created = await repo.banUpsert(ip, reason || "（未填写原因）", "admin", Date.now());
      return c.json({ created, ip });
    } catch { return jsonError(c, 503, "db_unavailable"); }
  });

  app.delete("/api/admin/bans/:ip", guard, async c => {
    const ip = normalizeIp(c.req.param("ip"));
    if (!ip) return jsonError(c, 400, "invalid_body", { message: "ip 不合法" });
    try { const ok = await repo.banRemove(ip); return ok ? c.body(null, 204) : jsonError(c, 404, "not_found"); }
    catch { return jsonError(c, 503, "db_unavailable"); }
  });

  app.delete("/api/admin/messages/:id", guard, async c => {
    const id = parseIdParam(c.req.param("id"));
    if (!id) return jsonError(c, 400, "invalid_cursor");
    const now = Date.now();
    try {
      const ok = await repo.softDeleteMessage(id, "admin", now);
      if (!ok) return jsonError(c, 404, "not_found");
      await repo.insertEvent("delete", JSON.stringify({ id: String(id) }), now);
      return c.body(null, 204);
    } catch { return jsonError(c, 503, "db_unavailable"); }
  });
}
```

`src/app.ts` 追加 `registerAdmin(app, { cfg, repo, history, maintain })`。

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test tests/integration/app.admin.test.ts`
预期：PASS（含 429 登录限流时不冲突——登录 5/min，测试共 4 次登录，安全）

- [ ] **步骤 5：Commit**

```bash
git add src/routes/admin.ts src/app.ts tests/integration/app.admin.test.ts
git commit -m "feat: admin JSON API with HMAC session cookie (T7)"
```

---

## 任务 8：静态页服务 + 管理页 + 验证 Demo

**文件：**

- 创建：`src/routes/pages.ts`、`public/admin.html`、`public/demo.html`
- 修改：`src/app.ts`
- 测试：`tests/integration/app.pages.test.ts`

- [ ] **步骤 1：写页面冒烟测试（先红）**

`tests/integration/app.pages.test.ts`：

```ts
import { describe, expect, test, afterEach } from "bun:test";
import { makeApp } from "../helpers";
let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const boot = async () => { const h = await makeApp(); cleanups.push(h.cleanup); return h; };

describe("静态页", () => {
  test("GET / → 302 /demo.html；/demo.html 与 /admin 返回 200 且含关键标记", async () => {
    const { app } = await boot();
    const root = await app.request("/");
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/demo.html");
    const demo = await (await app.request("/demo.html")).text();
    expect(demo).toContain("id=\"messages\"");
    expect(demo).toContain("wl.client"); // client_id 持久化键
    const admin = await (await app.request("/admin")).text();
    expect(admin).toContain("ADMIN_SECRET");
    expect(admin).toContain("/api/admin/login");
    const alias = await app.request("/admin.html");
    expect(alias.status).toBe(200);
  });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/integration/app.pages.test.ts`
预期：FAIL（404）

- [ ] **步骤 3：实现 pages 路由（同源读 public/）**

`src/routes/pages.ts`：

```ts
import type { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const readPublic = async (file: string) => {
  // 本地/测试 cwd 为仓库根；Vercel includeFiles 把 public/** 打进函数工作目录
  return readFile(join(process.cwd(), "public", file), "utf8");
};

export function registerPages(app: Hono) {
  app.get("/", c => c.redirect("/demo.html", 302));
  app.get("/demo.html", async c => { try { return c.html(await readPublic("demo.html")); } catch { return c.body("demo 页缺失", 404); } });
  app.get("/admin", async c => { try { return c.html(await readPublic("admin.html")); } catch { return c.body("admin 页缺失", 404); } });
  app.get("/admin.html", c => c.redirect("/admin", 302));
}
```

- [ ] **步骤 4：实现 admin.html（零构建；登录→三块面板）**

要点（完整实现）：

- 登录区：口令输入 → `POST /api/admin/login`（fetch + credentials），成功后 localStorage 无需存（HttpOnly cookie 自动带）。
- 面板 1 状态：`GET /api/admin/stats`（online/messages/history.mode/estimate_bytes）。
- 面板 2 封禁：`GET /api/admin/bans` 列表；新增表单（IP + 原因 → POST）；每行删除按钮（DELETE）；页顶提示本机 IP（`GET /api/meta` 的 `client_ip`）与"封禁本机 IP"按钮（POST 该 IP）。
- 面板 3 消息：`GET /api/messages?limit=20` 显示最近消息与"删除"按钮（`DELETE /api/admin/messages/:id`）。
- 所有响应非 2xx 时读取 `error.message` 弹 alert；CSS 极简（系统字体、单栏卡片）。
- 校验 JS 语法用 `bun run typecheck` 覆盖不到 HTML 内联脚本，靠浏览器手动验收（T9 清单）。

- [ ] **步骤 5：实现 demo.html（零构建，契约参考客户端）**

`public/demo.html` 实现要点（完整实现）：

- 顶部条：在线数（SSE presence）、当前 IP（`/api/meta`）、链接"管理页"、小字连接状态（connected/reconnecting）。
- 昵称持久化 `localStorage["wl.nick"]`；`client_id` 持久化 `localStorage["wl.client"]`（`crypto.randomUUID()`，无则生成）——多标签同 id = 按"人"计在线（规格口径）。
- 历史加载：`GET /api/messages?limit=50` 渲染（软删显示"(已删除)"占位）。
- 发送：`POST /api/messages`；403/429 用服务端 message 提示；`enter` 快捷发送。
- 实时：**手写 SSE 读取器**（`fetch` + `ReadableStream`），示范契约重连：

  ```js
  let since = 0, esClosed = false;
  async function connect() {
    while (!esClosed) {
      setStatus("connecting…");
      try {
        const res = await fetch(`/api/stream?client_id=${cid}${since ? `&since=${since}` : ""}`);
        if (!res.ok) { await sleep(2000); continue; }
        setStatus("connected");
        const reader = res.body.getReader();
        const dec = new TextDecoder(); let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            handleBlock(block);            // 解析 event:/data: → handle
          }
        }
      } catch { /* 断线 */ }
      setStatus("reconnecting…"); await sleep(1000);   // Demo 用固定 1s 重连示范循环；真实客户端可换指数退避（上限 ~30s）
    }
  }
  ```

- 去重：渲染前用 `lastSeenId`（消息 id 数字）跳过 ≤ 已渲染最新 id 的消息；事件流 message 与历史加载重叠经 id 去重（Map）。
- 禁言自测：面板显示"封禁本机 IP"（调用 `POST /api/admin/login` 需口令输入框 + 再 `POST /api/admin/bans`），按钮旁注：封禁后本机发消息将收到 403。
- 事件 `notice` 打印 `history_mode` 变化；`error` 事件显示状态条。

- [ ] **步骤 6：运行页面测试验证通过**

运行：`bun test tests/integration/app.pages.test.ts`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add src/routes/pages.ts public/admin.html public/demo.html src/app.ts tests/integration/app.pages.test.ts
git commit -m "feat: same-origin static pages + admin UI + SSE reference demo client (T8)"
```

---

## 任务 9：部署形态 —— index.ts 双入口 + vercel.json + 本地端到端验收

**文件：**

- 创建：`src/index.ts`、`vercel.json`
- 修改：`src/app.ts`（导出默认 cfg/repo 组装，供 index 复用）

- [ ] **步骤 1：实现入口（Bun dev 双入口 + Vercel Node handler）**

`src/app.ts` 追加工厂复用：

```ts
// 生产组装（读真实 env）——index.ts 使用
export async function buildApp() {
  const { loadConfig } = await import("./lib/config");
  const { createRepo } = await import("./lib/repo");
  const cfg = loadConfig();
  const repo = await createRepo(cfg.dbProvider, cfg.databaseUrl, cfg.tursoAuthToken);
  return { cfg, repo, app: createApp({ cfg, repo }) };
}
```

`src/index.ts`：

```ts
import { handle } from "hono/node-serverless";
import { buildApp } from "./app";

let state: { app: import("hono").Hono } | null = null;
const getApp = async () => { state ??= { app: (await buildApp()).app }; return state.app; };

if (import.meta.main) {
  const { cfg, app } = await buildApp();
  const server = Bun.serve({ port: cfg.port, fetch: app.fetch, idleTimeout: 300 });
  console.log(`weblive-chat dev server → http://localhost:${server.port}/demo.html`);
}

// Vercel @vercel/node 入口（单函数承接全部路由）
export default handle(async (req: Request) => (await getApp()).fetch(req));
```

`vercel.json`：

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "builds": [
    {
      "src": "src/index.ts",
      "use": "@vercel/node",
      "config": { "maxDuration": 300, "includeFiles": ["public/**"] }
    }
  ],
  "routes": [{ "src": "/(.*)", "dest": "src/index.ts" }]
}
```

- [ ] **步骤 2：typecheck 全量通过**

运行：`bun run typecheck`
预期：无错误

- [ ] **步骤 3：全量测试（sqlite）**

运行：`bun test`
预期：全部 PASS

- [ ] **步骤 4：本地端到端手工验收（起 dev server）**

```bash
cp .env.example .env   # 改 ADMIN_SECRET 为随机串
bun run dev
```

逐项验收（curl 方式给出关键命令，浏览器走一遍 demo）：

1. `curl -N "http://localhost:3000/api/stream?client_id=$(uuidgen)"` 回车后另开终端发一条消息，观察收到 `event: message`。
2. `curl -s http://localhost:3000/api/messages?limit=5` 见历史。
3. 浏览器开 `http://localhost:3000/demo.html`：收发正常、在线数 >0、断网（停 dev server）后重启可见"reconnecting"并自动续接（消息不丢不重）。
4. 浏览器开 `/admin`：口令登录 → 封禁本机 IP → demo 发送出现 403 禁言提示，流仍在线可旁观。
5. 会话 Cookie 含 HttpOnly/SameSite=Lax（DevTools → Application → Cookies）。

- [ ] **步骤 5：Commit**

```bash
git add src/index.ts src/app.ts vercel.json
git commit -m "feat: Vercel single-function entry + vercel.json + E2E acceptance (T9)"
```

> Vercel 线上部署验收（有账号时）：`vercel deploy` 后验证（a）`/demo.html` 可访问；（b）SSE 广播 ~1s 内到达；（c）SSE 流在 300s 上限处断开后自动重连（DevTools Network 观察新请求带 since 续传）。此步阻塞项记入 §10 回归清单，不阻塞本地验收。

---

## 任务 10：README 与 API 文档收尾

**文件：**

- 重写：`README.md`
- 创建：`docs/api.md`
- 修改：`docs/superpowers/specs/2026-09-09-weblive-chat-backend-design.md`（状态 draft → approved）

- [ ] **步骤 1：重写 README（中文）**

要点（完整撰写）：

- 一句话定位 + 架构示意（demo/前端 → Vercel Hono → Turso/可选 PG）。
- 快速开始：`bun install`、`cp .env.example .env`、`bun run dev`、访问 `/demo.html`（先看它能不能工作）；管理页 `/admin`。
- 环境变量表（照抄 `.env.example` + 默认值列 + 说明列）。
- 部署：Vercel 单函数说明（含 `vercel.json` 已配好）、`file:` 禁止作生产存储警告、Turso 建库指引（`turso db create` + token → `.env`）、Neon/Supabase 走 `postgres://…?sslmode=require`。
- 测试：`bun test`（sqlite）；PG 双库 `bun run test:pg`。
- 契约速览链接 `docs/api.md`；完整设计见规格文档。
- 合规提示：免登录公开历史 = 公开存档；`HISTORY_MAX_BACKFILL` 收紧；IP 属个人数据，封禁表自证用途。
- 已知边界：禁词为子串匹配；精确 IP 封禁（CIDR 后置）；`x-forwarded-for` 直连 Vercel 才可信，套 CDN 时需调整取跳。

- [ ] **步骤 2：从规格 §5 提取 `docs/api.md`**

内容 = §5 公开端点表 + SSE 事件类型表 + 错误码表 + 管理端点表 + Origin 白名单行为 + `curl` 三例（发消息/拉历史/订阅流）。注明"权威来源：spec §5，v0.1 草案"。

- [ ] **步骤 3：规格状态置为 approved 并补充实现记录小节**

在规格头部把 `状态：待审查（draft）` → `状态：已批准（approved，2026-09-09）`，并在文档末追加实现后记录（接口修正要点：events payload 构造于事务内、SSE `client_id` 参数、`rate_limits` 落地、repo 为手写 SQL）。

- [ ] **步骤 4：终检**

```bash
bun run typecheck && bun test && git status --porcelain   # 应干净
```

- [ ] **步骤 5：Commit**

```bash
git add README.md docs/api.md docs/superpowers/specs/2026-09-09-weblive-chat-backend-design.md
git commit -m "docs: README quickstart, API reference, spec approved (T10)"
```

---

## 规格覆盖对照（自检）

| 规格章节/要求 | 任务 |
|---|---|
| §1.1 MVP：匿名聊天/在线人数/历史加载 | T5/T6/T8 |
| 管理员封禁/删消息/看在线与消息 | T7 + admin.html(T8) |
| 基础防滥用（限流/长度/禁词） | T3/T5 |
| 历史滚动保留 + 自动收缩/降级 notice | T4/T5（maintain 接入 T7 stats） |
| D2 免登录 client_id + ADMIN_SECRET Cookie | T3/T5/T7 |
| D3 SSE+POST、D4 events 总线、§3 循环 | T4/T6 |
| D5 禁言不禁看（ban 提示事件） | T4/T6/T5(403) |
| D7/D13/D16 启动自建表、无 ORM | T2 |
| D11 §4.1 可移植性（epoch ms/字符串 id/无方言函数） | T2/T5（iso 输出） |
| D12/§6.1 Origin 白名单 | T3(纯)/T5(中间件) |
| D14 历史回溯深度可配 | T5（backfillMax） |
| D15/§5 meta client_ip + 一键自封 | T5/T8 |
| §5 流与游标语义（回退规则） | T4（runStream 回退） |
| §8 测试矩阵（sqlite 恒跑 + PG 可选） | T2/T3–T8 tests + helpers |
| §10 部署/驱动/静态页 spike | T2(驱动)/T6/T8/T9 验收 |

**风险与后续（计划外但已记录）：** Vercel 上 `streamSSE` + `@vercel/node` 的行为需线上实测（T9 验收）；`postgres.js` 连接在冷启动下的建立成本、`ssl` 探测；`readPublic` 在 Vercel 的 cwd 假设（includeFiles 已处理）；presence 快照在各实例各自广播的一致性（§7.2 语义允许）。
