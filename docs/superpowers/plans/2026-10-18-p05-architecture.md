# 阶段 05：架构收尾 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把已经证明会重复的三处知识收拢（事件载荷、存储能力、配置夹具），给流循环注入时钟，清掉 `any`，最后补齐双运行时类型检查与变更日志。

**架构：** 新增 `src/lib/events.ts`（纯函数：载荷形状）与 `src/lib/ports.ts`（把 25 方法的 `Repo` 拆成 6 个窄接口，`Repo` 仍是它们的组合，adapter 不变）；路由依赖从 `Repo` 收窄到各自需要的 port；`runStream` 接受 `now`/`sleep` 注入。

**技术栈：** TypeScript 泛型与接口组合、Biome lint、`tsc -p tsconfig.node.json`。

**规格：** `docs/superpowers/plans/2026-10-18-optimization-roadmap.md`（全局约束与审查重点对每个任务都生效）。

## 全局约束

- 本阶段**不改变任何 HTTP 契约与数据库 schema**，只是把同样的行为换一种组织方式；任何响应体差异都是回归。
- `Repo` 接口保持向后兼容：`Repo extends MessageStore, EventOutbox, …`，三个 adapter 一行不改实现，只改类型声明。
- 删除测试（deletion test）：`events.ts` 与 `ports.ts` 若被删除，复杂度必须重新散回 3 个 adapter / 5 个调用方——若不然，说明这两个模块是多余的，应重新设计而不是保留。

---

### 任务 1：事件载荷构造集中（E2）

**文件：**
- 创建：`src/lib/events.ts`
- 修改：`src/lib/repo.ts`（三处载荷拼装）、`src/app.ts`（notice 事件）
- 测试：`tests/unit/events.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
describe("事件载荷", () => {
  test("message：id 为字符串，字段与契约一致", () => {
    expect(messageEventPayload({ client_id: "c", nick: "n", text: "t", created_at: 7 }, 42))
      .toEqual({ id: "42", client_id: "c", nick: "n", text: "t", created_at: 7 });
  });
  test("ephemeral：id 带 e 前缀且不落 messages 命名空间", () => {
    const id = ephemeralMessageId();
    expect(id).toMatch(/^e[0-9a-f-]{36}$/);
  });
  test("delete：只带 id，不泄露正文", () => {
    expect(deleteEventPayload(42)).toEqual({ id: "42" });
  });
  test("notice：history_mode 的字段名与客户端约定一致", () => {
    expect(historyNoticePayload("ephemeral", 1)).toEqual({ kind: "history_mode", mode: "ephemeral", retention_days: 1 });
  });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/unit/events.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 3：实现 `src/lib/events.ts`**

```ts
import type { MessageInput } from "./repo";
import type { HistoryMode } from "./history";

/** 出站事件载荷的唯一形状来源：三个方言 adapter 都从这里取，契约变更只改一处。 */
export interface MessageEventPayload {
  id: string; client_id: string; nick: string; text: string; created_at: number;
}

export function messageEventPayload(m: MessageInput, id: number | string): MessageEventPayload {
  return { id: String(id), client_id: m.client_id, nick: m.nick, text: m.text, created_at: m.created_at };
}

/** ephemeral 消息不进 messages 表：e+uuid 避免与 messages.id 空间混淆。 */
export function ephemeralMessageId(): string {
  return `e${crypto.randomUUID()}`;
}

export function deleteEventPayload(id: number | string): { id: string } {
  return { id: String(id) };
}

export function historyNoticePayload(mode: HistoryMode, retentionDays: number) {
  return { kind: "history_mode" as const, mode, retention_days: retentionDays };
}
```

- [ ] **步骤 4：替换三处拼装**

- `SqliteRepo.sendMessageAndEvent`：`JSON.stringify(messageEventPayload(m, messageId))`
- `PostgresRepo.sendMessageAndEvent`：同上
- `MemoryRepo.sendMessageAndEvent`：同上
- `publishEphemeralMessage`：`const id = ephemeralMessageId(); insertEvent("message", JSON.stringify(messageEventPayload(m, id)), m.created_at)`
- `src/app.ts` 的 notice：`JSON.stringify(historyNoticePayload(res.mode, res.retentionDays))`

- [ ] **步骤 5：运行确认通过**

运行：`bun test && bun run typecheck`
预期：全绿，且 `rg -n 'kind: "history_mode"' src` 只剩 `events.ts` 一处。

- [ ] **步骤 6：Commit**

```bash
git add src tests
git commit -m "refactor(事件): 载荷构造集中到 lib/events，三方言共用"
```

---

### 任务 2：`Repo` 拆成窄接口（E1）

**文件：**
- 创建：`src/lib/ports.ts`
- 修改：`src/lib/repo.ts`（`interface Repo extends …`）、`src/routes/chat.ts`、`src/routes/admin.ts`、`src/routes/health.ts`
- 测试：`tests/unit/ports.test.ts`（编译期替身）

- [ ] **步骤 1：写失败测试（以"最小替身"表达接口宽度）**

```ts
import { describe, expect, test } from "bun:test";
import type { StreamRepo } from "../../src/lib/stream";
import type { ChatRepo } from "../../src/lib/ports";

test("StreamRepo 只需要 5 个方法就能构造替身", () => {
  const fake: StreamRepo = {
    eventsSince: async () => [],
    eventsMaxId: async () => 0,
    presenceUpsert: async () => {},
    presenceCount: async () => 0,
    banGet: async () => null,
  };
  expect(Object.keys(fake)).toHaveLength(5);
});

test("ChatRepo 不要求 purge/maintenance 能力", () => {
  // @ts-expect-error —— ChatRepo 上不存在 purgeCounts（能通过编译即说明收窄成功）
  const bad: ChatRepo = { purgeCounts: async () => ({}) } as ChatRepo;
  expect(bad).toBeDefined();
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/unit/ports.test.ts && bun run typecheck`
预期：FAIL，`../../src/lib/ports` 不存在。

- [ ] **步骤 3：定义 ports**

`src/lib/ports.ts`：

```ts
import type { BanRow, EventRow, MessageInput, MessageRow } from "./repo";
import type { PurgeCounts, PurgeScope } from "./purge";
import type { RateSink } from "./limits";

export interface MessageStore {
  historyBefore(before: number, limit: number): Promise<MessageRow[]>;
  historySince(since: number, limit: number): Promise<MessageRow[]>;
  softDeleteMessageAndEvent(id: number, by: string, at: number): Promise<boolean>;
}

export interface EventOutbox {
  insertEvent(type: string, payload: string, created_at: number): Promise<number>;
  eventsSince(since: number, limit: number): Promise<EventRow[]>;
  eventsMaxId(): Promise<number>;
  sendMessageAndEvent(m: MessageInput): Promise<{ messageId: number; eventId: number }>;
  publishEphemeralMessage(m: MessageInput): Promise<{ messageId: string }>;
}

export interface PresenceStore {
  presenceUpsert(clientId: string, at: number): Promise<void>;
  presenceCount(cutoff: number): Promise<number>;
}

export interface BanStore {
  banUpsert(ip: string, reason: string, by: string, at: number): Promise<boolean>;
  banGet(ip: string): Promise<{ reason: string; created_at: number } | null>;
  banList(limit: number, offset: number): Promise<BanRow[]>;
  banRemove(ip: string): Promise<boolean>;
}

export interface PurgeStore {
  purgeCounts(): Promise<PurgeCounts>;
  clearData(scope: PurgeScope): Promise<PurgeCounts>;
}

export interface MaintenanceStore {
  ping(): Promise<void>;
  schemaInfo(): Promise<{ version: number; indexes: string[] }>;
  messageStats(): Promise<{ total: number; retained: number }>;
  cleanupEvents(before: number): Promise<number>;
  cleanupPresence(before: number): Promise<number>;
  cleanupRateLimits(before: number): Promise<number>;
  trimMessagesBelow(idFloor: number): Promise<number>;
  deleteMessagesOlderThan(cutoff: number): Promise<number>;
  idAtOffset(offset: number): Promise<number | null>;
}

/** 聊天路由需要的最小能力：读历史、写消息、在线数、封禁、限流。 */
export type ChatRepo = MessageStore & EventOutbox & PresenceStore & BanStore & RateSink;
/** 后台需要的能力：封禁、消息、清空、维护与限流。 */
export type AdminRepo = BanStore & MessageStore & PurgeStore & MaintenanceStore & PresenceStore & RateSink;
```

- [ ] **步骤 4：让 `Repo` 组合它们**

`src/lib/repo.ts`：把 25 条方法声明从 `interface Repo` 里删掉，改为：

```ts
export interface Repo
  extends MessageStore, EventOutbox, PresenceStore, BanStore, PurgeStore, MaintenanceStore, RateSink {
  readonly provider: Provider;
  bootstrap(): Promise<void>;
  close(): Promise<void>;
}
```

并 `import type { … } from "./ports";`。三个 adapter 不改实现（它们已经实现了这些方法）。

- [ ] **步骤 5：路由依赖收窄**

- `ChatDeps.repo: ChatRepo`（`registerChat` 内部对 `repo` 的用法不变；`runStream` 需要的 `StreamRepo` 由 `ChatRepo` 满足）。
- `AdminDeps.repo: AdminRepo`。
- `registerHealth` 的 deps 用 `{ ping(): Promise<void> }`。
- `AppDeps.repo: Repo` 保持不变（`createApp` 需要全量）。

- [ ] **步骤 6：运行确认通过**

运行：`bun test && bun run typecheck`
预期：全绿；`tests/integration/*` 传 `makeRepo()` 的返回值（`Repo` 可赋给 `ChatRepo`）。

- [ ] **步骤 7：Commit**

```bash
git add src tests
git commit -m "refactor(存储): Repo 拆为 6 个窄接口，路由只依赖所需能力"
```

---

### 任务 3：测试夹具改由 `loadConfig` 生成（E4）

**文件：**
- 修改：`tests/helpers.ts`
- 测试：既有全部测试

- [ ] **步骤 1：先记录当前漂移面**

运行：`rg -n "windowMs|pgPoolMax|adminRequireOrigin|historyPerMin" tests/helpers.ts`
预期：确认 `testCfg` 里手写的字段与 `AppConfig` 的差异（这就是漂移来源）。

- [ ] **步骤 2：改写 `testCfg`**

```ts
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
    // 时间常量不是 env：测试需要毫秒级而不是秒级。
    pollMs: 10,
    idlePollMs: 10,
    idleAfterMs: 1_000_000,
    eventProbeMs: 0,
    presenceUpsertMs: 10,
    presenceCountMs: 10,
    ...over,
  };
}
```

- [ ] **步骤 3：验证新增字段自动出现**

```ts
test("testCfg 自动继承 loadConfig 的新字段（无手工漂移）", () => {
  const c = testCfg();
  expect(c.adminRequireOrigin).toBe(false);
  expect(c.rate.historyPerMin).toBe(60);
  expect(c.pgPrepare).toBe(true);
  expect(c.statsTtlMs).toBe(60_000);
});
```

- [ ] **步骤 4：运行确认通过**

运行：`bun test && bun run typecheck`
预期：全绿。若某测试依赖 `testCfg` 曾覆盖过的值（例如 `bannedWordsDir`），在 `over` 里显式传，不要改回手写对象。

- [ ] **步骤 5：Commit**

```bash
git add tests/helpers.ts tests/unit/config.test.ts
git commit -m "test: 夹具改由 loadConfig 生成，消除配置漂移"
```

---

### 任务 4：流循环注入时钟（E5）

**文件：**
- 修改：`src/lib/stream.ts`
- 修改：`src/routes/chat.ts`（不传即用默认值）
- 测试：`tests/unit/stream.test.ts`

- [ ] **步骤 1：写失败测试（用假时钟验证空闲退避）**

```ts
test("空闲超过 idleAfterMs 后改用 idlePollMs", async () => {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const repo = { eventsSince: async () => [], eventsMaxId: async () => 0, presenceUpsert: async () => {}, presenceCount: async () => 1, banGet: async () => null };
  const ctrl = runStream({
    repo, clientId: "c", since: 0,
    cfg: { ...streamCfg(), pollMs: 100, idlePollMs: 3000, idleAfterMs: 1000, eventProbeMs: 0, heartbeatMs: 999_999 },
    emit: () => {},
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
  });
  for (let i = 0; i < 40 && sleeps.length < 3; i++) await Promise.resolve();
  ctrl.stop();
  await new Promise((r) => setTimeout(r, 10));
  expect(sleeps[0]).toBe(100);
  expect(sleeps[sleeps.length - 1]).toBe(3000);
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/unit/stream.test.ts -t "空闲超过"`
预期：FAIL，`sleeps[0]` 为真实时间戳（约 100 但后续不受控）。

- [ ] **步骤 3：注入 `now` / `sleep`**

`StreamOpts` 加 `now?: () => number; sleep?: (ms: number) => Promise<void>;`；模块内：

```ts
const now = o.now ?? Date.now;
const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
```

把循环里所有 `Date.now()` 换成 `now()`（`rg -n "Date.now()" src/lib/stream.ts` 结果应为 0）。

- [ ] **步骤 4：运行确认通过**

运行：`bun test && bun run typecheck`
预期：全绿。

- [ ] **步骤 5：Commit**

```bash
git add src/lib/stream.ts tests/unit/stream.test.ts
git commit -m "refactor(流): 注入 now/sleep，时序可测且不再依赖真实时间"
```

---

### 任务 5：清掉 `any` 并开启 Biome 推荐规则（F5）

**文件：**
- 修改：`src/lib/repo.ts`、`src/routes/chat.ts`、`src/lib/validate.ts`、`biome.json`

- [ ] **步骤 1：先让编译器暴露问题**

把 `src/lib/repo.ts` 的 `mapMessage`/`mapEvent` 参数从 `any` 改成 `Row`（`type Row = Record<string, unknown>`），运行 `bun run typecheck`。
预期：报错指出需要类型收窄的位置——这些就是本任务要改的点。

- [ ] **步骤 2：加收窄助手并改完映射**

```ts
type Row = Record<string, unknown>;
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const nullableNum = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));

const mapMessage = (r: Row): MessageRow => ({
  id: num(r.id),
  client_id: str(r.client_id),
  nick: str(r.nick),
  text: r.deleted_at === null || r.deleted_at === undefined ? str(r.text) : null,
  created_at: num(r.created_at),
  deleted: !(r.deleted_at === null || r.deleted_at === undefined),
  deleted_at: nullableNum(r.deleted_at),
});
```

`query<any>` 全部改 `query<Row>`；`args: any[]` 改 `args: readonly unknown[]`，写进驱动前用 `as InValue[]`（从 `@libsql/client` 导入 `type InValue`）；`toPgParams(sql: string, args: readonly unknown[])`。

- [ ] **步骤 3：chat 去 any**

```ts
const fmtMessage = (m: MessageRow) => ({ … });
let rows: MessageRow[];
```

并把 `body.client_id as string` 去掉：`src/lib/validate.ts` 的成功分支返回 `client_id`（它已经通过了 `validUuid`）：

```ts
| { ok: true; client_id: string; nick: string; text: string };
```

`chat.ts` 用 `client_id: v.client_id`。

- [ ] **步骤 4：验证 `any` 清零**

运行：`rg -n "\bany\b" src`
预期：无输出（`Record<string, unknown>` 与 `unknown` 不是 `any`）。

- [ ] **步骤 5：打开 Biome 推荐规则并修剩余项**

`biome.json`：`"linter": { "enabled": true, "rules": { "recommended": true } }`，并把有意为之的规则显式关掉：`"suspicious": { "noExplicitAny": "error", "noConsole": "off" }`（日志就是走 console，见 `src/lib/log.ts`）。
运行：`bunx biome check --write .` 后再 `bunx biome check .`。
预期：0 error；剩余 warning 逐条判断，能用代码修的就修，确实必要的用 `// biome-ignore lint/<rule>: <理由>` 标注。

- [ ] **步骤 6：运行确认通过**

运行：`bun test && bun run typecheck && bunx biome check .`
预期：全绿。

- [ ] **步骤 7：Commit**

```bash
git add -A
git commit -m "refactor(类型): 清除 any，开启 Biome 推荐规则"
```

---

### 任务 6：双运行时类型检查（F7）

**文件：**
- 创建：`tsconfig.node.json`
- 修改：`tsconfig.json`、`package.json`、`.github/workflows/ci.yml`

- [ ] **步骤 1：加 Node 类型依赖**

运行：`bun add -d @types/node`
预期：`package.json` 出现 `@types/node`。

- [ ] **步骤 2：写 `tsconfig.node.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "types": ["node"], "noEmit": true },
  "include": ["src"],
  "exclude": ["src/index.ts"]
}
```

`src/index.ts` 是唯一的 `Bun.serve` 入口，按设计只能在 Bun 下编译；排除它并用下面这条守卫兜底。

- [ ] **步骤 3：加脚本与守卫**

`package.json`：`"typecheck:node": "tsc -p tsconfig.node.json"`。
CI 的 `test` job 增加两步：

```yaml
      - run: bun run typecheck:node
      - run: "! rg -n 'Bun\\.' src --glob '!src/index.ts'"
```

- [ ] **步骤 4：本地验证**

运行：`bun run typecheck:node && ! rg -n 'Bun\.' src --glob '!src/index.ts'`
预期：`tsc` 无输出；`rg` 无匹配（退出码 1 被 `!` 反转，命令整体成功）。

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "ci: 增加 Node 运行时类型检查与 Bun API 使用守卫"
```

---

### 任务 7：变更日志与契约版本（F8）

**文件：**
- 创建：`CHANGELOG.md`
- 修改：`docs/api.md`（顶部契约版本）、`README.md`（如未同步）

- [ ] **步骤 1：写 `CHANGELOG.md`**

```markdown
# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；API 契约版本见 `docs/api.md` 顶部。

## [Unreleased]

### Added
- `GET /api/health`：DB 探活 + provider + 历史模式 + 进程内指标。
- `x-request-id` 响应头与单行 JSON 错误日志。
- 安全响应头与基于 sha256 的内联脚本 CSP。
- 管理写操作的同源 Origin 校验（`ADMIN_REQUIRE_ORIGIN`，生产默认开）。
- 历史读取独立限流桶（`RATE_HISTORY_PER_MIN`）。
- Postgres 连接参数（`PG_POOL_MAX`/`PG_PREPARE`/`PG_IDLE_TIMEOUT_S`/`PG_CONNECT_TIMEOUT_S`）。
- `schema_version` 表与事件/限流清理索引。

### Changed
- 维护移出请求路径，改为后台调度；统计 60s 缓存。
- ephemeral 消息改为单条 INSERT，id 形如 `e<uuid>`。
- 客户端重连改为指数退避 + 抖动；SSE 下发 `retry: 3000`。

### Fixed
- `GET /api/messages?since=0` 现在从最早升序返回。
- `BANNED_WORDS_DIR=` 空值回落到默认目录；零词时告警。
- purge 令牌不可跨窗口/清库后重放。
- 存储故障不再拖垮静态页。
- 删消息与 delete 事件合并为单事务。
- 请求体超过 16KB 返回 413。
- 流内错误不再把内部异常原文下发给客户端。

## [1.0.0] - 2026-09-09
- 首个版本：SSE 实时、三方存储、管理后台、IP 封禁。
```

- [ ] **步骤 2：`docs/api.md` 顶部标注契约版本**

在标题下方加：`> 契约版本：v1（2026-09-09 起；2026-10 优化批次为向后兼容新增）`。

- [ ] **步骤 3：`docs/design.md` §11 追加批次汇总注记**

在 §11 实现注记末尾追加：

```markdown
### 2026-10 优化批次（实现注记）

- 新增 `lib/log.ts`（结构化错误日志）、`lib/metrics.ts`（进程内计数）、`routes/health.ts`。
- 事件载荷统一由 `lib/events.ts` 构造，三方言不再各自拼 JSON。
- 维护从请求路径移到 `lib/maintenance.ts` 的调度器；统计 60s 缓存。
- `messages` 裁剪改用 `idAtOffset`，回溯深度不再整段载入。
- `purge_used` 账本不再随 `full` 清库删除。
- 存储层：`Repo` 拆为 `lib/ports.ts` 的 6 个窄接口，路由只依赖所需能力。
```

（上一段按实际结果写入，不要保留这句提示。）

- [ ] **步骤 4：核对文档与代码一致**

逐条对照 `docs/api.md` 的端点表与 `src/routes/*.ts` 的注册路径：`rg -n 'app\.(get|post|delete)\("' src/routes`，确认没有文档未登录的端点，也没有文档里有而代码没有的端点。

- [ ] **步骤 5：运行确认无代码影响**

运行：`bun test && bun run typecheck`
预期：全绿。

- [ ] **步骤 6：Commit**

```bash
git add -A
git commit -m "docs: 新增 CHANGELOG 并标注 API 契约版本 v1"
```

---

## 阶段收尾检查

- [ ] 全量回归：`bun run lint && bun run typecheck && bun run typecheck:node && bun run test:coverage`
- [ ] `rg -n "\bany\b" src` 无输出
- [ ] `rg -n "await d\.maintain" src` 无输出（维护已异步）
- [ ] `git log --oneline` 每个任务一条 commit，且信息为中文 Conventional Commits
- [ ] 由一位全新审查者做整分支 review（子代理驱动模式下的最后一步）
