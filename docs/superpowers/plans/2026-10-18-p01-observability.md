# 阶段 01：可观测性 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让每一次 503 都能在服务端日志里被定位，让存储故障不再把内部异常泄露给客户端，并提供一个无鉴权的健康检查端点。

**架构：** 新增 `src/lib/log.ts`（单行 JSON 日志，无依赖）与 `src/lib/metrics.ts`（进程内计数），在 `app.ts` 的 `/api/*` 中间件里生成 request id 并回写 `x-request-id`；`src/routes/health.ts` 用新增的 `repo.ping()` 做 DB 探活。

**技术栈：** Hono 中间件与类型化 `Env`、`node:crypto`、`bun:test` 的 `spyOn`。

**规格：** `docs/superpowers/plans/2026-10-18-optimization-roadmap.md`（全局约束与审查重点对每个任务都生效）。

## 全局约束

- 本阶段不改任何成功路径的响应体；只加响应头、日志与 `/api/health`。
- 日志里**绝不**出现 `ADMIN_SECRET`、cookie、purge 令牌、消息正文。
- `x-request-id` 必须同时出现在 4xx/5xx 响应上。

---

### 任务 1：`src/lib/log.ts`

**文件：**
- 创建：`src/lib/log.ts`
- 测试：`tests/unit/log.test.ts`

- [ ] **步骤 1：写失败测试**

`tests/unit/log.test.ts`：

```ts
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { logError, logInfo, newRequestId } from "../../src/lib/log";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });
function capture() {
  const lines: string[] = [];
  spies.push(spyOn(console, "error").mockImplementation((s) => { lines.push(String(s)); }));
  return lines;
}

describe("log", () => {
  test("logError 输出单行 JSON，含 scope/msg/stack 与附加字段", () => {
    const lines = capture();
    logError("chat", new Error("boom"), { request_id: "r1", status: 503 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    const o = JSON.parse(lines[0]);
    expect(o.level).toBe("error");
    expect(o.scope).toBe("chat");
    expect(o.msg).toBe("boom");
    expect(o.stack).toContain("Error: boom");
    expect(o.request_id).toBe("r1");
    expect(o.status).toBe(503);
    expect(typeof o.at).toBe("number");
  });

  test("非 Error 值被字符串化，undefined 字段被丢弃", () => {
    const lines = capture();
    logError("db", "plain string", { request_id: undefined });
    const o = JSON.parse(lines[0]);
    expect(o.msg).toBe("plain string");
    expect("request_id" in o).toBe(false);
  });

  test("logInfo 用 event 而不是 scope", () => {
    const lines = capture();
    logInfo("purge", { scope: "chat", deleted: 3 });
    const o = JSON.parse(lines[0]);
    expect(o.level).toBe("info");
    expect(o.event).toBe("purge");
    expect(o.deleted).toBe(3);
  });

  test("newRequestId 是 UUID", () => {
    expect(newRequestId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/unit/log.test.ts`
预期：FAIL，报 `Cannot find module '../../src/lib/log'`。

- [ ] **步骤 3：实现**

创建 `src/lib/log.ts`：

```ts
/** Single-line JSON logs: platform log search works without a log library. */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function logError(scope: string, err: unknown, fields: LogFields = {}): void {
  const base: Record<string, unknown> = {
    level: "error",
    scope,
    msg: err instanceof Error ? err.message : String(err),
  };
  if (err instanceof Error && err.stack) base.stack = err.stack;
  emit(base, fields);
}

export function logInfo(event: string, fields: LogFields = {}): void {
  emit({ level: "info", event }, fields);
}

function emit(base: Record<string, unknown>, fields: LogFields): void {
  const line: Record<string, unknown> = { ...base, at: Date.now() };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) line[k] = v;
  console.error(JSON.stringify(line));
}
```

`logInfo` 也走 `console.error`：Vercel 的 stdout/stderr 同权，统一一个通道便于 `grep '"level":"info"'`；不要改成 `console.log`，测试与生产要保持一致。

- [ ] **步骤 4：运行确认通过**

运行：`bun test tests/unit/log.test.ts && bun run typecheck`
预期：`4 pass`，`tsc` 无输出。

- [ ] **步骤 5：Commit**

```bash
git add src/lib/log.ts tests/unit/log.test.ts
git commit -m "feat(日志): 新增单行 JSON 日志模块"
```

---

### 任务 2：request id + 替换 chat/app 的静默 catch

**文件：**
- 修改：`src/lib/http.ts`（新增 `AppEnv` 与 `getRequestId`）
- 修改：`src/app.ts:63-69`、`src/routes/chat.ts`（3 处 `catch {}`）、`src/routes/admin.ts:9`（`Context` 类型）、`src/routes/pages.ts:1`
- 测试：`tests/integration/observability.test.ts`

- [ ] **步骤 1：写失败测试**

`tests/integration/observability.test.ts`：

```ts
import { describe, expect, spyOn, test } from "bun:test";
import { createApp } from "../../src/app";
import { makeRepo, testCfg } from "../helpers";

describe("可观测性", () => {
  test("存储异常 → 503 + x-request-id + 一行 JSON 日志", async () => {
    const { repo, cleanup } = await makeRepo("memory");
    const lines: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((s) => { lines.push(String(s)); });
    (repo as any).historyBefore = async () => { throw new Error("sqlite: disk I/O error"); };
    const app = createApp({ cfg: testCfg(), repo });

    const res = await app.fetch(new Request("http://x/api/messages"));
    expect(res.status).toBe(503);
    const rid = res.headers.get("x-request-id");
    expect(rid).toMatch(/^[0-9a-f-]{36}$/);

    const logged = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const hit = logged.find((o: any) => o.request_id === rid);
    expect(hit).toBeDefined();
    expect(hit!.level).toBe("error");
    expect(hit!.msg).toContain("disk I/O error");
    // 客户端响应不得泄露内部异常
    expect(JSON.stringify(await res.json())).not.toContain("disk I/O error");
    spy.mockRestore();
    await cleanup();
  });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/integration/observability.test.ts`
预期：FAIL，`x-request-id` 为 `null`。

- [ ] **步骤 3：在 `src/lib/http.ts` 定义 AppEnv 与读取器**

```ts
export type AppEnv = { Variables: { requestId: string } };

export function getRequestId(c: Context<AppEnv>): string {
  return c.get("requestId") ?? "unknown";
}
```

- [ ] **步骤 4：在 `src/app.ts` 的 `/api/*` 中间件最前面写 request id**

在 `app.use("/api/*", async (c, next) => {` 的第一行插入：

```ts
const rid = newRequestId();
c.set("requestId", rid);
c.header("x-request-id", rid);
```

并把 `createApp` 的返回类型与实例类型改成 `Hono<AppEnv>`（`const app = new Hono<AppEnv>();`、`export function createApp(deps: AppDeps): Hono<AppEnv>`），`bootstrap` 的 catch 改为：

```ts
} catch (err) {
  logError("boot", err, { request_id: getRequestId(c) });
  return jsonError(c, 503, "db_unavailable");
}
```

`registerChat` / `registerAdmin` / `registerPages` 的签名同步改为 `app: Hono<AppEnv>`，内部 `Context` 改为 `Context<AppEnv>`，`jsonError` 的参数类型改为 `Context<AppEnv>`。若 `tsc` 在某个 helper 上报不可赋值，把该 helper 的 `Context` 一并改成 `Context<AppEnv>`——不要用 `any` 绕过。

- [ ] **步骤 5：替换 `src/routes/chat.ts` 的三处静默 catch**

三处都改成 `catch (err) { logError("chat.messages.get" | "chat.messages.post" | "chat.stream.rate", err, { request_id: getRequestId(c) }); return jsonError(c, 503, "db_unavailable"); }`（按所在路由取 scope 名，保持一一对应）。

- [ ] **步骤 6：运行确认通过**

运行：`bun test && bun run typecheck`
预期：`bun test` 全绿（含新 1 条），`tsc` 无输出。

- [ ] **步骤 7：Commit**

```bash
git add src tests
git commit -m "feat(日志): /api/* 注入 request id，路由 catch 记录结构化错误"
```

---

### 任务 3：流内错误脱敏 + 记录（A4）

**文件：**
- 修改：`src/lib/stream.ts:123-126`
- 测试：`tests/unit/stream.test.ts`

- [ ] **步骤 1：写失败测试**

在 `tests/unit/stream.test.ts` 追加：

```ts
test("DB 异常：只下发 code，不下发原始错误；并记录日志", async () => {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((s) => { lines.push(String(s)); });
  const errs: Array<[string, unknown]> = [];
  const repo = {
    eventsSince: async () => { throw new Error("postgres://user:pw@host/db refused"); },
    eventsMaxId: async () => 0,
    presenceUpsert: async () => {},
    presenceCount: async () => 0,
    banGet: async () => null,
  };
  runStream({
    repo, clientId: "c1", since: 0,
    cfg: { ...streamCfg(), pollMs: 1, eventProbeMs: 0 },
    emit: (t, d) => errs.push([t, d]),
  });
  await new Promise((r) => setTimeout(r, 30));
  const [type, data] = errs.find(([t]) => t === "error")!;
  expect(type).toBe("error");
  expect(data).toEqual({ code: "db_unavailable" });
  expect(JSON.stringify(data)).not.toContain("postgres://");
  expect(lines.some((l) => JSON.parse(l).scope === "stream")).toBe(true);
  spy.mockRestore();
});
```

（`streamCfg()` 若测试文件里已有等价工厂就用现成的，不要新造。）

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/unit/stream.test.ts`
预期：FAIL，`data` 里含 `postgres://`。

- [ ] **步骤 3：改 `src/lib/stream.ts` 的 catch**

```ts
})().catch((err) => {
  // 内部错误只进日志：SSE 帧对任意浏览器可见，不能带出 SQL/连接串。
  logError("stream", err, { client_id: o.clientId, since });
  o.emit("error", { code: "db_unavailable" });
  stopped = true;
});
```

在文件顶部 `import { logError } from "./log";`。

- [ ] **步骤 4：运行确认通过**

运行：`bun test tests/unit/stream.test.ts tests/integration/app.memory.test.ts`
预期：全绿（若既有断言期望 `message` 字段，同步删除该断言）。

- [ ] **步骤 5：Commit**

```bash
git add src/lib/stream.ts tests/unit/stream.test.ts
git commit -m "fix(流): 内部异常不再下发给客户端，改为服务端结构化日志"
```

---

### 任务 4：`GET /api/health`

**文件：**
- 修改：`src/lib/repo.ts`（接口 + 三实现）、`src/app.ts`（注册）
- 创建：`src/routes/health.ts`
- 测试：`tests/integration/health.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
test("健康检查：DB 正常 200，DB 异常 503", async () => {
  const { repo, cleanup } = await makeRepo("memory");
  const app = createApp({ cfg: testCfg(), repo });
  const ok = await app.fetch(new Request("http://x/api/health"));
  expect(ok.status).toBe(200);
  const body = await ok.json();
  expect(body).toMatchObject({ ok: true, provider: "memory" });
  expect(typeof body.mode).toBe("string");

  (repo as any).ping = async () => { throw new Error("down"); };
  const bad = await app.fetch(new Request("http://x/api/health"));
  expect(bad.status).toBe(503);
  expect((await bad.json()).ok).toBe(false);
  await cleanup();
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/integration/health.test.ts`
预期：FAIL，404。

- [ ] **步骤 3：给 Repo 加 `ping`**

接口加 `/** Cheapest liveness probe: SELECT 1. */ ping(): Promise<void>;`
- `SqliteRepo`：`async ping() { await this.c.execute("SELECT 1"); }`
- `PostgresRepo`：`async ping() { await this.sql.unsafe("SELECT 1"); }`
- `MemoryRepo`：`async ping() {}`

- [ ] **步骤 4：实现路由并注册**

`src/routes/health.ts`：

```ts
import type { Hono } from "hono";
import type { AppEnv } from "../lib/http";
import type { AppConfig } from "../lib/config";
import type { Repo } from "../lib/repo";
import type { HistoryMode } from "../lib/history";
import { logError } from "../lib/log";
import { metricsSnapshot } from "../lib/metrics";

export function registerHealth(
  app: Hono<AppEnv>,
  d: { cfg: AppConfig; repo: Repo; history: { mode: HistoryMode } },
) {
  app.get("/api/health", async (c) => {
    const base = { provider: d.cfg.dbProvider, mode: d.history.mode, runtime: metricsSnapshot() };
    try {
      await d.repo.ping();
      return c.json({ ok: true, ...base });
    } catch (err) {
      logError("health", err, { request_id: c.get("requestId") ?? "unknown" });
      return c.json({ ok: false, ...base }, 503);
    }
  });
}
```

在 `createApp` 里 `registerHealth(app, { cfg, repo, history });`（放在 `registerChat` 之前）。`metricsSnapshot` 由任务 5 提供；本任务先创建 `src/lib/metrics.ts` 的骨架并返回 `{}`，任务 5 再补计数（同一阶段内可接受，因为两任务连续执行）。

- [ ] **步骤 5：运行确认通过**

运行：`bun test tests/integration/health.test.ts && bun run typecheck`
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add src tests
git commit -m "feat(运维): 新增 /api/health（DB 探活 + provider + 历史模式）"
```

---

### 任务 5：进程内指标 + admin 侧日志 + purge 审计

**文件：**
- 创建：`src/lib/metrics.ts`（替换任务 4 的骨架）
- 修改：`src/routes/admin.ts`（7 处 catch、stats 增加 runtime、purge 审计改 `logInfo`）
- 修改：`src/routes/chat.ts`（流连接数增减）
- 测试：`tests/unit/metrics.test.ts`、`tests/integration/observability.test.ts`

- [ ] **步骤 1：写失败测试（指标）**

```ts
test("指标可增可减且快照是拷贝", () => {
  resetMetrics();
  incMetric("activeStreams");
  incMetric("activeStreams");
  decMetric("activeStreams");
  expect(metricsSnapshot().active_streams).toBe(1);
  const snap = metricsSnapshot();
  (snap as any).active_streams = 99;
  expect(metricsSnapshot().active_streams).toBe(1);
});
```

- [ ] **步骤 2：实现 `src/lib/metrics.ts`**

```ts
/** 进程内计数：Serverless 每实例独立，只用于排障与容量观察，不作业务真相。 */
const counters = { activeStreams: 0, dbErrors: 0, maintenanceRuns: 0, streamsOpened: 0 };
export type MetricName = keyof typeof counters;

export function incMetric(name: MetricName): void { counters[name] += 1; }
export function decMetric(name: MetricName): void { counters[name] = Math.max(0, counters[name] - 1); }
export function resetMetrics(): void { for (const k of Object.keys(counters) as MetricName[]) counters[k] = 0; }

export function metricsSnapshot(): Record<string, number> {
  return {
    active_streams: counters.activeStreams,
    streams_opened: counters.streamsOpened,
    db_errors: counters.dbErrors,
    maintenance_runs: counters.maintenanceRuns,
  };
}
```

- [ ] **步骤 3：在 chat 的流生命周期里计数**

`src/routes/chat.ts` 的 `streamSSE` 回调内：`incMetric("activeStreams"); incMetric("streamsOpened");` 放在 `runStream` 之前；在 `stream.onAbort(() => {...})` 里 `decMetric("activeStreams")`。用计数器守卫避免重复减：`let counted = true;` 在 `decMetric` 前判断。

- [ ] **步骤 4：admin 的 7 处 catch 记录日志**

每处改成 `catch (err) { logError("admin.<endpoint>", err, { request_id: getRequestId(c) }); return jsonError(c, 503, "db_unavailable"); }`，scope 取 `admin.stats` / `admin.bans.get` / `admin.bans.post` / `admin.bans.delete` / `admin.messages.delete` / `admin.purge.preview` / `admin.purge.run`。

- [ ] **步骤 5：stats 暴露 runtime，purge 审计结构化**

`/api/admin/stats` 的响应加 `runtime: metricsSnapshot()`。
purge 的审计行改成：

```ts
logInfo("audit.purge", { scope, ip, deleted: JSON.stringify(deleted) });
```

并把 `dbErrors` 在任何 `db_unavailable` 分支前 `incMetric("dbErrors")`（chat 与 admin 共 10 处；抽一个 `failDb(c, scope, err)` 本地 helper 减少重复）。

- [ ] **步骤 6：运行确认通过**

运行：`bun test && bun run typecheck`
预期：全绿。

- [ ] **步骤 7：Commit**

```bash
git add src tests
git commit -m "feat(运维): 进程内指标、admin 错误日志与 purge 结构化审计"
```
