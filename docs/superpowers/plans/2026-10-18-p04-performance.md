# 阶段 04：性能与成本 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 去掉 Serverless 上的四个成本热点（触顶维护全表读、重复 COUNT、回溯深度全量读、写请求内联维护），补齐两条清理索引，把 ephemeral 写入减半，并让客户端重连不再同步冲击。

**架构：** 存储层新增 `idAtOffset` 一个精确查询取代"读 N 行算边界"；维护从请求路径移到 `src/lib/maintenance.ts` 的后台调度器；统计用 60s TTL 缓存 + 删除量折算；连接参数与重连退避都是纯函数，可单测。

**技术栈：** libsql / postgres.js、Hono SSE、`bun:test` 的 `mock`/`spyOn`。

**规格：** `docs/superpowers/plans/2026-10-18-optimization-roadmap.md`（全局约束与审查重点对每个任务都生效）。

## 全局约束

- 维护改为异步后，**任何测试**都不得依赖"写完后 stats 立刻变化"；需要确定性的测试通过注入 `maintenance.flush()` 等待（见任务 6）。
- 新增的 SQL 必须进契约测试（sqlite + memory 双跑），并且只用可移植子集（`?` 占位符）。
- 索引与 `schema_version` 必须能在已有库上幂等执行（`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`）。

---

### 任务 1：schema_version + 两条清理索引（B5 / F6）

**文件：**
- 修改：`src/lib/ddl.ts`
- 测试：`tests/integration/repo.test.ts`

- [ ] **步骤 1：写失败测试**

在契约套件里加：

```ts
test("DDL：schema_version 落一行，清理用索引存在", async () => {
  await repo.bootstrap();
  await repo.bootstrap(); // 幂等
  const r = await (repo as any).run?.("SELECT version FROM schema_version", []);
  // 若 repo 未暴露 run：改为通过 purgeCounts/自定义查询验证，见步骤 3 的辅助方法
});
```

统一改为在 `Repo` 上暴露只读探针（生产也用得上）：

```ts
/** 运维探针：返回已应用的 schema 版本与关键索引名，供 /api/health 与测试使用。 */
schemaInfo(): Promise<{ version: number; indexes: string[] }>;
```

测试：

```ts
test("DDL 幂等：schema_version=1，事件与限流清理索引存在", async () => {
  await repo.bootstrap();
  await repo.bootstrap();
  const info = await repo.schemaInfo();
  expect(info.version).toBe(1);
  expect(info.indexes.sort()).toEqual(
    expect.arrayContaining(["idx_events_created_at", "idx_rate_limits_window"]),
  );
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/integration/repo.test.ts -t "DDL 幂等"`
预期：FAIL，`repo.schemaInfo is not a function`。

- [ ] **步骤 3：改 DDL**

`src/lib/ddl.ts` 的返回数组追加：

```ts
`CREATE TABLE IF NOT EXISTS schema_version (version integer PRIMARY KEY)`,
provider === "sqlite"
  ? `INSERT OR IGNORE INTO schema_version (version) VALUES (1)`
  : `INSERT INTO schema_version (version) VALUES (1) ON CONFLICT DO NOTHING`,
`CREATE INDEX IF NOT EXISTS idx_events_created_at ON events (created_at)`,
`CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits (window_start)`,
```

- [ ] **步骤 4：实现 `schemaInfo`（三方言）**

- `SqliteRepo`：`SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'` + `SELECT MAX(version) AS v FROM schema_version`。
- `PostgresRepo`：`SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema()` + `SELECT MAX(version) AS v FROM schema_version`。
- `MemoryRepo`：返回 `{ version: 1, indexes: ["idx_events_created_at", "idx_rate_limits_window"] }`（内存无索引，但契约要一致，便于测试替身）。

- [ ] **步骤 5：运行确认通过**

运行：`bun test && bun run typecheck`
预期：全绿。

- [ ] **步骤 6：Commit**

```bash
git add src tests
git commit -m "perf(存储): 增加 schema_version 与事件/限流清理索引"
```

---

### 任务 2：裁剪不再读全表（B1）

**文件：**
- 修改：`src/lib/repo.ts`（`idAtOffset` + 三实现）
- 修改：`src/lib/history.ts:78-88`
- 测试：`tests/integration/repo.test.ts`、`tests/unit/history.test.ts`

- [ ] **步骤 1：写失败测试**

契约套件：

```ts
async function seed(n: number) {
  for (let i = 1; i <= n; i++)
    await repo.sendMessageAndEvent({ client_id: CID, nick: "n", text: `t${i}`, created_at: 1 });
}

test("idAtOffset：按 id 倒序取第 n 个，越界返回 null", async () => {
  await seed(3);
  expect(await repo.idAtOffset(0)).toBe(3);
  expect(await repo.idAtOffset(2)).toBe(1);
  expect(await repo.idAtOffset(9)).toBeNull();
});
```

`tests/unit/history.test.ts`（先补一个本地 deps 工厂，后续任务复用）：

```ts
function historyDeps(over: Record<string, any> = {}) {
  const calls: string[] = [];
  const repo = {
    cleanupEvents: async () => { calls.push("cleanupEvents"); return 0; },
    cleanupPresence: async () => { calls.push("cleanupPresence"); return 0; },
    cleanupRateLimits: async () => { calls.push("cleanupRateLimits"); return 0; },
    messageStats: async () => { calls.push("messageStats"); return { total: 0, retained: 0 }; },
    deleteMessagesOlderThan: async () => { calls.push("deleteMessagesOlderThan"); return 0; },
    idAtOffset: async () => { calls.push("idAtOffset"); return null; },
    trimMessagesBelow: async () => { calls.push("trimMessagesBelow"); return 0; },
    ...over,
  };
  return {
    calls,
    deps: {
      repo: repo as any,
      cfg: {
        maxRows: 3,
        retentionDays: 90,
        presenceTtlMs: 45_000,
        eventsTtlMs: 3_600_000,
        maintenanceEvery: 100,
      },
      state: newHistoryState(),
    },
  };
}
```

（`cfg` 的字段按任务 3 追加 `statsTtlMs: 60_000`。）

```ts
test("触顶裁剪不调用 historyBefore（不再整表读）", async () => {
  const { deps, calls } = historyDeps({
    messageStats: async () => ({ total: 5, retained: 5 }),
    idAtOffset: async () => 3,
    trimMessagesBelow: async () => 2,
  });
  await performMaintenance(deps, 1_000);
  expect(calls.filter((c) => c === "idAtOffset")).toHaveLength(1);
  expect(calls).not.toContain("historyBefore");
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/unit/history.test.ts`
预期：FAIL，`idAtOffset` 未定义 / `historyBefore` 被调用。

- [ ] **步骤 3：加 `idAtOffset`**

`SQL.idAtOffset = "SELECT id FROM messages ORDER BY id DESC LIMIT 1 OFFSET ?"`。
- `SqliteRepo`：`const r = await this.run<{ id: number }[]>(SQL.idAtOffset, [offset]); return r[0] ? Number(r[0].id) : null;`
- `PostgresRepo`：同一 SQL 走 `this.query`，`Number(...)`。
- `MemoryRepo`：`const sorted = [...this.messages].sort((a, b) => b.id - a.id); const m = sorted[offset]; return m ? m.id : null;`

接口签名：`idAtOffset(offset: number): Promise<number | null>;`

- [ ] **步骤 4：history 改用它**

`HistoryDeps.repo` 用 `idAtOffset(offset: number): Promise<number | null>` 替换 `historyBefore`（并删掉那条"必须 id-DESC"的注释）。`performMaintenance` 触顶分支改为：

```ts
if (cfg.maxRows > 0 && retained >= cfg.maxRows) {
  const floor = await repo.idAtOffset(cfg.maxRows - 1);
  // floor 是第 maxRows 新的 id：删掉更早的，正好留 maxRows 行。
  if (floor !== null) deleted += await repo.trimMessagesBelow(floor);
}
```

- [ ] **步骤 5：运行确认通过**

运行：`bun test && bun run typecheck`
预期：全绿。

- [ ] **步骤 6：Commit**

```bash
git add src tests
git commit -m "perf(存储): 触顶裁剪改用 idAtOffset，不再整表载入内存"
```

---

### 任务 3：统计缓存，避免重复 COUNT（B2）

**文件：**
- 修改：`src/lib/history.ts`（`HistoryState.stats`、`performMaintenance` 接收 state）
- 修改：`src/app.ts`（把 `history` 传进去）
- 测试：`tests/unit/history.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
test("60s 内多次维护只 COUNT 一次", async () => {
  let statsCalls = 0;
  const { deps } = historyDeps({
    messageStats: async () => { statsCalls += 1; return { total: 5, retained: 5 }; },
  });
  await performMaintenance(deps, 1_000);
  await performMaintenance(deps, 2_000);
  await performMaintenance(deps, 3_000);
  expect(statsCalls).toBe(1);
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/unit/history.test.ts -t "只 COUNT 一次"`
预期：FAIL，实际 3。

- [ ] **步骤 3：加缓存字段与读取器**

`HistoryState` 加 `stats: { at: number; retained: number } | null;`，`newHistoryState()` 返回 `stats: null`。
`HistoryDeps` 加 `state: HistoryState;` 与 `cfg.statsTtlMs: number`（在 `config.ts` 里加非 env 常量 `statsTtlMs: 60_000`，与既有 `pollMs` 等常量放在一起）。

`performMaintenance` 开头：

```ts
let retained: number;
const cached = deps.state.stats;
if (cached && now - cached.at < cfg.statsTtlMs) retained = cached.retained;
else {
  ({ retained } = await repo.messageStats());
  deps.state.stats = { at: now, retained };
}
```

删除两处中途的 `({ retained } = await repo.messageStats())`，改为按实际删除量折算：
`retained = Math.max(0, retained - deletedDays)`、`retained = Math.max(0, retained - trimmed)`。
函数末尾 `deps.state.stats = { at: now, retained };`。

- [ ] **步骤 4：app 传入 state**

`src/app.ts` 的 `performMaintenance({ repo, cfg, state: history }, now)`。

- [ ] **步骤 5：运行确认通过**

运行：`bun test && bun run typecheck`
预期：全绿。既有 `tests/unit/history.test.ts` 里直接构造 deps 的用例需要补 `state: newHistoryState()` 与 `statsTtlMs: 60_000`；`app.memory.test.ts` 的降级测试若依赖精确计数，把该测试的 `statsTtlMs` 设为 `0`。

- [ ] **步骤 6：Commit**

```bash
git add src tests
git commit -m "perf(存储): messageStats 60s 缓存，删除量按差值折算"
```

---

### 任务 4：回溯深度不再多读 N 行（B3）

**文件：**
- 修改：`src/routes/chat.ts:81-86`
- 测试：`tests/integration/app.chat.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
test("HISTORY_MAX_BACKFILL=2 只返回最新 2 条，且不整段载入", async () => {
  const { app, cleanup } = await makeApp({ backfillMax: 2 });
  for (const t of ["a", "b", "c"]) await repo.sendMessageAndEvent({ client_id: CID, nick: "n", text: t, created_at: 1 });
  const j = await (await app.fetch(new Request("http://x/api/messages?limit=50"))).json();
  expect(j.messages.map((m: any) => m.id)).toEqual(["3", "2"]);
  const spy = spyOn(repo, "historyBefore");
  await app.fetch(new Request("http://x/api/messages?limit=50"));
  expect(spy).not.toHaveBeenCalled();
  await cleanup();
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/integration/app.chat.test.ts -t "BACKFILL"`
预期：FAIL，`historyBefore` 被调用（用于算 cutoff）。

- [ ] **步骤 3：改用 idAtOffset 取边界**

```ts
let cutoff: number | null = null;
if (cfg.backfillMax > 0) {
  // 第 backfillMax 新的 id 就是回溯下界；越界说明行数不足，不设限。
  cutoff = await repo.idAtOffset(cfg.backfillMax - 1);
}
```

- [ ] **步骤 4：运行确认通过**

运行：`bun test tests/integration/app.chat.test.ts && bun run typecheck`
预期：全绿。

- [ ] **步骤 5：Commit**

```bash
git add src tests
git commit -m "perf(接口): 回溯深度用 idAtOffset 取边界，不再多读 N 行"
```

---

### 任务 5：ephemeral 单条写入（B6）

**文件：**
- 修改：`src/lib/repo.ts`（`publishEphemeralMessage` + 接口返回类型）、`src/routes/chat.ts`
- 测试：`tests/integration/repo.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
test("publishEphemeralMessage：一次写入，payload.id 即返回 id，messages 不增", async () => {
  const before = await repo.purgeCounts();
  const { messageId } = await repo.publishEphemeralMessage({ client_id: CID, nick: "n", text: "hi", created_at: 1 });
  expect(messageId).toMatch(/^e[0-9a-f-]{36}$/);
  const ev = await repo.eventsSince(0, 10);
  expect(ev).toHaveLength(1);
  expect(JSON.parse(ev[0].payload)).toMatchObject({ id: messageId, nick: "n", text: "hi" });
  expect((await repo.purgeCounts()).messages).toBe(before.messages);
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/integration/repo.test.ts -t "publishEphemeralMessage"`
预期：FAIL，`messageId` 为 `e<数字>` 且实现里是 INSERT+UPDATE 两次写。

- [ ] **步骤 3：改为单条 INSERT**

接口改为 `publishEphemeralMessage(m: MessageInput): Promise<{ messageId: string }>;`

三方言统一：

```ts
async publishEphemeralMessage(m: MessageInput): Promise<{ messageId: string }> {
  const id = `e${crypto.randomUUID()}`;
  const payload = JSON.stringify({ id, client_id: m.client_id, nick: m.nick, text: m.text, created_at: m.created_at });
  const eventId = await this.insertEvent("message", payload, m.created_at);
  return { messageId: id };
}
```

（Sqlite/PG 复用各自的 `insertEvent`；Memory 复用其内存实现。）

- [ ] **步骤 4：chat 直接用返回的 id**

`src/routes/chat.ts`：

```ts
const { messageId } = await repo.publishEphemeralMessage(msg);
d.maintain?.();
return c.json({ id: messageId, created_at: iso(msg.created_at) }, 201);
```

- [ ] **步骤 5：运行确认通过**

运行：`bun test && bun run typecheck`
预期：全绿（`app.memory.test.ts` 若断言 `e<数字>`，改为正则 `/^e[0-9a-f-]{36}$/`）。

- [ ] **步骤 6：Commit**

```bash
git add src tests
git commit -m "perf(存储): ephemeral 消息改为单条 INSERT，写入量减半"
```

---

### 任务 6：维护移出请求路径（B4）

**文件：**
- 创建：`src/lib/maintenance.ts`
- 修改：`src/app.ts`、`src/routes/chat.ts`（`maintain` 变同步）、`src/routes/admin.ts`
- 测试：`tests/unit/maintenance.test.ts`、`tests/integration/app.memory.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
test("hit() 不阻塞；到阈值后台跑一次；flush() 等待完成", async () => {
  let runs = 0;
  const m = createMaintenance({ every: 3, run: async () => { runs += 1; await new Promise((r) => setTimeout(r, 5)); } });
  m.hit(1); m.hit(2);
  expect(runs).toBe(0);
  m.hit(3);
  expect(runs).toBe(1);          // 已启动，但没有 await
  await m.flush();
  expect(runs).toBe(1);
});

test("运行期间的写入会补偿触发一次（合并，不丢）", async () => {
  let runs = 0;
  const m = createMaintenance({ every: 1, run: async () => { runs += 1; await new Promise((r) => setTimeout(r, 5)); } });
  m.hit(1); m.hit(2); m.hit(3);
  await m.flush();
  // 第一次触发在运行中，三次 hit 合并成第二次触发：共 2 次，且不会饥饿到 0 次。
  expect(runs).toBe(2);
});
```

- [ ] **步骤 2：实现 `src/lib/maintenance.ts`**

```ts
export interface Maintenance {
  /** 记一次写；到阈值就在后台跑，不返回 Promise。 */
  hit(now?: number): void;
  /** 测试与优雅停机用：等待当前及补偿触发全部完成。 */
  flush(): Promise<void>;
}

export function createMaintenance(o: {
  every: number;
  run: (now: number) => Promise<void>;
  onError?: (err: unknown) => void;
}): Maintenance {
  let writes = 0;
  let done = 0;            // 已完成触发所对应的写入数
  let pending: Promise<void> | null = null;

  const maybeRun = (now: number) => {
    if (pending || writes - done < o.every) return;
    done = writes;
    pending = o.run(now)
      .catch((err) => o.onError?.(err))
      .finally(() => {
        pending = null;
        // 运行期间又攒够一轮：补偿触发，避免饥饿。
        if (writes - done >= o.every) maybeRun(Date.now());
      });
  };

  return {
    hit(now = Date.now()) { writes += 1; maybeRun(now); },
    async flush() { while (pending) await pending; },
  };
}
```

- [ ] **步骤 3：app 接上调度器**

`AppDeps` 加可选 `maintenance?: Maintenance`。`createApp` 内：

```ts
const maint = deps.maintenance ?? createMaintenance({
  every: cfg.maintenanceEvery,
  run: async (now) => {
    const res = await performMaintenance({ repo, cfg, state: history }, now);
    if (res.mode !== history.mode || res.retentionDays !== history.retentionDays) {
      const prev = history.mode;
      history.mode = res.mode;
      history.retentionDays = res.retentionDays;
      if (prev !== res.mode) {
        await repo.insertEvent("notice", JSON.stringify({ kind: "history_mode", mode: res.mode, retention_days: res.retentionDays }), now).catch(() => {});
      }
    }
  },
  onError: (err) => logError("maintenance", err),
});

const maintain = (now = Date.now()) => {
  maint.hit(now);
  return { mode: history.mode, retentionDays: history.retentionDays };
};
```

`maintain` 现在是同步函数：`ChatDeps.maintain?: (now?: number) => { mode; retentionDays }`，`AdminDeps.maintain` 同型。所有 `await d.maintain()` 改成 `d.maintain()`（`rg -n "await d.maintain"`）。

- [ ] **步骤 4：测试改为显式 flush**

`tests/integration/app.memory.test.ts` 的降级测试：构造 `const maintenance = createMaintenance({ every: 1, run: ... })` 不方便（要复用 app 内部的）。改为：`createApp({ cfg, repo, maintenance: { hit() {}, flush: async () => {} } })` 不可行——那样维护根本不跑。

改用真实调度器 + `maintenanceEvery: 1` + 每次写后 `await app.__maintenance.flush()`：

```ts
export interface AppDeps {
  cfg: AppConfig;
  repo: Repo;
  maintenance?: Maintenance;
}
export interface AppHandle { app: Hono<AppEnv>; maintenance: Maintenance; }
```

`createApp` 增加一个可选导出 `createAppWithHandle(deps): AppHandle`（内部 `createApp` 复用它），测试用 handle：

```ts
const { app, maintenance } = createAppWithHandle({ cfg: testCfg({ maintenanceEvery: 1 }), repo });
await send(...); await maintenance.flush();
expect(...mode === "ephemeral")
```

- [ ] **步骤 5：运行确认通过**

运行：`bun test && bun run typecheck`
预期：全绿。

- [ ] **步骤 6：Commit**

```bash
git add src tests
git commit -m "perf(写路径): 维护改为后台调度，POST 不再承担清理尾延迟"
```

---

### 任务 7：Postgres 连接参数（B8）

**文件：**
- 修改：`src/lib/config.ts`、`src/lib/repo.ts`（`createRepo` 签名 + `pgOptions`）、`src/app.ts`、`tests/helpers.ts`
- 修改：`.env.example`、`README.md`
- 测试：`tests/unit/config.test.ts`（或新建 `tests/unit/repo-options.test.ts`）

- [ ] **步骤 1：写失败测试**

```ts
test("pgOptions 映射到 postgres.js 参数，prepare 可关", () => {
  expect(pgOptions({ pgPoolMax: 2, pgPrepare: false, pgIdleTimeoutS: 5, pgConnectTimeoutS: 3 }))
    .toEqual({ max: 2, prepare: false, idleTimeoutSec: 5, connectTimeoutSec: 3 });
  expect(loadConfig({ ...base }).pgPrepare).toBe(true);
  expect(loadConfig({ ...base, PG_PREPARE: "0" }).pgPrepare).toBe(false);
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/unit/repo-options.test.ts`
预期：FAIL，`pgOptions` 不存在。

- [ ] **步骤 3：加配置**

`AppConfig`：`pgPoolMax: number; pgPrepare: boolean; pgIdleTimeoutS: number; pgConnectTimeoutS: number;`
`loadConfig`：`pgPoolMax: envInt(env, "PG_POOL_MAX", 1)`、`pgPrepare: (env.PG_PREPARE ?? "1") !== "0"`、`pgIdleTimeoutS: envInt(env, "PG_IDLE_TIMEOUT_S", 20)`、`pgConnectTimeoutS: envInt(env, "PG_CONNECT_TIMEOUT_S", 10)`。
`testCfg` 补四个字段。

- [ ] **步骤 4：`createRepo` 改 options 对象**

```ts
export interface PgOptions { max: number; prepare: boolean; idleTimeoutSec: number; connectTimeoutSec: number }
export interface RepoOptions { authToken?: string; pg?: PgOptions }

export function pgOptions(cfg: Pick<AppConfig, "pgPoolMax" | "pgPrepare" | "pgIdleTimeoutS" | "pgConnectTimeoutS">): PgOptions {
  return { max: cfg.pgPoolMax, prepare: cfg.pgPrepare, idleTimeoutSec: cfg.pgIdleTimeoutS, connectTimeoutSec: cfg.pgConnectTimeoutS };
}

export async function createRepo(provider: Provider, databaseUrl: string, o: RepoOptions = {}): Promise<Repo> {
  if (provider === "memory") return new MemoryRepo();
  if (provider === "sqlite") return new SqliteRepo(createClient({ url: databaseUrl, authToken: o.authToken }));
  const ssl = /[?&]sslmode=require/.test(databaseUrl) ? "require" : false;
  const pg = o.pg ?? { max: 1, prepare: true, idleTimeoutSec: 20, connectTimeoutSec: 10 };
  return new PostgresRepo(postgres(databaseUrl, {
    ssl, max: pg.max, prepare: pg.prepare,
    idle_timeout: pg.idleTimeoutSec, connect_timeout: pg.connectTimeoutSec,
  }));
}
```

`buildApp`：`createRepo(cfg.dbProvider, cfg.databaseUrl, { authToken: cfg.tursoAuthToken, pg: pgOptions(cfg) })`。
`tests/helpers.ts`：`createRepo("memory", "")` → `createRepo("memory", "")`（兼容），`createRepo(provider, realUrl)` 不变。运行 `rg -n "createRepo\(" src tests` 确认没有第三个位置参数残留。

- [ ] **步骤 5：文档**

`.env.example` 的数据库段加四行（含注释「Supabase/pgBouncer 事务模式请设 PG_PREPARE=0」）；README 变量表同步。

- [ ] **步骤 6：运行确认通过**

运行：`bun test && bun run typecheck`
预期：全绿。

- [ ] **步骤 7：Commit**

```bash
git add -A
git commit -m "feat(存储): Postgres 连接参数可配（池大小/空闲/连接超时/prepare）"
```

---

### 任务 8：重连退避 + SSE retry 帧（B7）

**文件：**
- 创建：`public/retry.js`
- 修改：`src/routes/pages.ts`（服务 `/retry.js`）、`public/demo.html`、`src/routes/chat.ts`（`retry:` 帧）
- 修改：`docs/integration.md`
- 测试：`tests/unit/backoff.test.ts`、`tests/integration/demo-page.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
test("backoffDelay：指数增长、封顶 30s、带向下抖动", async () => {
  await import("../../public/retry.js");
  const f = (globalThis as any).backoffDelay;
  expect(f(0, () => 1)).toBe(1000);
  expect(f(1, () => 1)).toBe(2000);
  expect(f(4, () => 1)).toBe(16000);
  expect(f(9, () => 1)).toBe(30000);   // 封顶
  expect(f(0, () => 0)).toBe(500);     // 抖动下界 0.5x
  expect(f(10, () => 0.5)).toBe(15000);
});
```

- [ ] **步骤 2：实现 `public/retry.js`**

```js
/* 零依赖、可被页面与 bun test 共用：重连退避 + 抖动，避免全站客户端同时回连。 */
(function (g) {
  g.backoffDelay = function (attempt, rand) {
    var base = Math.min(30000, 1000 * Math.pow(2, attempt));
    return Math.round(base * (0.5 + rand() * 0.5));
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
```

- [ ] **步骤 3：页面加载它并改重连循环**

`public/demo.html`：在 `<!--COPY-->` 之前加 `<script src="/retry.js"></script>`；`connect()` 里把失败分支改为：

```js
let attempt = 0;
...
if (!res.ok) { ...; await sleep(backoffDelay(attempt++, Math.random)); continue; }
setStatus(COPY.chat.statusConnected, "ok");
attempt = 0;
...
// 读到流结束（平台 300s 上限）后：
setStatus(COPY.chat.statusReconnecting, "bad");
await sleep(backoffDelay(attempt++, Math.random));
```

- [ ] **步骤 4：`pages.ts` 提供 `/retry.js`**

```ts
app.get("/retry.js", async (c) => {
  c.header("cache-control", PAGE_CACHE);
  c.header("content-type", "application/javascript; charset=utf-8");
  return c.body(await readPublic("retry.js"));
});
```

- [ ] **步骤 5：SSE 下发 retry**

`src/routes/chat.ts` 的 `streamSSE` 回调第一行：`stream.write("retry: 3000\n\n");`
（不要用 `writeSSE({retry})`：该字段在部分 hono 版本会被当 data 序列化。）

- [ ] **步骤 6：文档**

`docs/integration.md` 的重连一节写明公式与「必须加抖动；服务端会下发 `retry: 3000` 作为初始值」。

- [ ] **步骤 7：运行确认通过**

运行：`bun test && bun run typecheck && bun test tests/integration/demo-page.test.ts`
预期：全绿；`demo-page.test.ts` 若枚举了页面脚本数量，补上 `/retry.js`。

- [ ] **步骤 8：Commit**

```bash
git add -A
git commit -m "perf(客户端): 重连指数退避+抖动，SSE 下发 retry 帧"
```

---

### 任务 9：单 tick 排空事件（B10）

**文件：**
- 修改：`src/lib/stream.ts:52-75`
- 测试：`tests/unit/stream.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
test("突发 250 条事件在一个 poll 周期内全部推送", async () => {
  const events = Array.from({ length: 250 }, (_, i) => ({
    id: i + 1,
    type: "message",
    payload: JSON.stringify({ id: String(i + 1) }),
    created_at: 1,
  }));
  const seen: number[] = [];
  const repo = {
    eventsSince: async (since: number, limit: number) =>
      events.filter((e) => e.id > since).slice(0, limit),
    eventsMaxId: async () => 250,
    presenceUpsert: async () => {},
    presenceCount: async () => 1,
    banGet: async () => null,
  };
  runStream({
    repo: repo as any,
    clientId: "c",
    since: 0,
    cfg: { ...cfg, pollMs: 20, eventProbeMs: 0 },
    emit: (type, data) => { if (type === "message") seen.push(Number((data as any).id)); },
  });
  await sleep(120);
  expect(seen).toHaveLength(250);
});
```

（`cfg` / `sleep` 复用该文件顶部已有的常量与辅助函数——见 `tests/unit/stream.test.ts:5` 与 `:29`。）

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/unit/stream.test.ts -t "突发 250"`
预期：FAIL，实际约 100 条（单轮 `LIMIT 100` 上限）。

- [ ] **步骤 3：在 `tickPoll` 里排空**

把"取一次 → 推一次"改为最多 5 轮的循环（`const MAX_ROUNDS = 5; const LIMIT = 100;`）：每轮 `eventsSince(since, LIMIT)`，推送后若 `rows.length < LIMIT` 或 `rounds >= MAX_ROUNDS` 则 break；`lastSent/lastEventAt` 的逻辑移到循环之后按 `pushed > 0` 统一更新。

- [ ] **步骤 4：运行确认通过**

运行：`bun test tests/unit/stream.test.ts && bun run typecheck`
预期：全绿。这个测试同时钉住两件事：单 tick 排空生效、`since` 游标推进不丢事件（审查重点第 4 条的第二个子句）。若 5 轮不足以推完 250 条，把 `MAX_ROUNDS` 调到 10；断言保持 250 全达。

- [ ] **步骤 5：Commit**

```bash
git add src/lib/stream.ts tests/unit/stream.test.ts
git commit -m "perf(流): 单 tick 内多轮排空，突发不再被 100 条/秒限速"
```
