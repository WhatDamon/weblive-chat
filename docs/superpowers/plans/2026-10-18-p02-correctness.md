# 阶段 02：正确性 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修掉六处已证实的契约/安全边界缺陷：`since=0` 语义、禁词目录空串、purge 令牌重放、DB 故障拖垮静态页、删消息与广播非原子、请求体无上限。

**架构：** 全部在既有模块内修正，不新增抽象；两处需要存储层配合（`softDeleteMessageAndEvent` 下沉、`clearData` 对 nonce 行豁免），仍由三个方言 adapter 各自实现同一契约。

**技术栈：** Hono、libsql / postgres.js 事务、`bun:test` 的 `setSystemTime`。

**规格：** `docs/superpowers/plans/2026-10-18-optimization-roadmap.md`（全局约束与审查重点对每个任务都生效）。

## 全局约束

- 不改变错误码命名风格：新增错误码必须同时进 `src/lib/copy.ts` 的 `COPY.error`（`ErrCode` 由此推导）。
- 每条修复都必须先有会失败的测试，且该测试在修复前能复现用户可见的错误行为。
- 契约测试在 sqlite 与 memory 上双跑；`softDeleteMessageAndEvent` 与 `clearData` 的 PG 实现必须与 sqlite 语义一致（PG 无法本地跑时由 CI 的 postgres job 兜底）。

---

### 任务 1：`GET /api/messages?since=0` 从最早开始（A1）

**文件：**
- 修改：`src/lib/http.ts:61-66`（新增 `parseSinceParam`）
- 修改：`src/routes/chat.ts:61`
- 测试：`tests/integration/app.chat.test.ts`
- 文档：`docs/api.md`（`since` 语义补一句"`0` 表示从最早开始"）

- [ ] **步骤 1：写失败测试**

在 `tests/integration/app.chat.test.ts` 加：

```ts
test("since=0 从最早升序返回，而不是最新一页", async () => {
  const { app, repo, cleanup } = await makeApp();
  for (const t of ["one", "two", "three"]) {
    await repo.sendMessageAndEvent({ client_id: CID, nick: "n", text: t, created_at: Date.now() });
  }
  const j = await (await app.fetch(new Request("http://x/api/messages?since=0&limit=2"))).json();
  expect(j.messages.map((m: any) => m.id)).toEqual(["1", "2"]);
});
```

（`makeApp` / `CID` 用文件里已有的工厂与常量，不要新造。）

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/integration/app.chat.test.ts -t "since=0"`
预期：FAIL，实际为 `["3","2"]`（最新优先）。

- [ ] **步骤 3：加 `parseSinceParam`**

`src/lib/http.ts`：

```ts
/** 游标 0 是合法的「从最早开始」；before 仍然要求 >= 1（见 parseIdParam）。 */
export function parseSinceParam(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? Math.min(n, MAX_ID_BOUND) : null;
}
```

- [ ] **步骤 4：chat 改用新解析器**

`src/routes/chat.ts`：`const since = parseSinceParam(c.req.query("since"));`，import 同步更新。`before !== null && since !== null` 的互斥判断保持不变。

- [ ] **步骤 5：运行确认通过**

运行：`bun test tests/integration/app.chat.test.ts && bun run typecheck`
预期：全绿。

- [ ] **步骤 6：Commit**

```bash
git add src tests docs/api.md
git commit -m "fix(接口): /api/messages?since=0 从最早升序返回"
```

---

### 任务 2：禁词目录空串与零词告警（A2）

**文件：**
- 修改：`src/lib/config.ts:118`、`src/lib/wordfilter.ts`（`loadWordFilter` 末尾）
- 修改：`.env.example`（`BANNED_WORDS_DIR` 注释）
- 测试：`tests/unit/config.test.ts`、`tests/unit/wordfilter.test.ts`

- [ ] **步骤 1：写失败测试**

`tests/unit/config.test.ts`：

```ts
test("BANNED_WORDS_DIR 空串/空白回落到 cwd/data/banned", () => {
  const def = join(process.cwd(), "data/banned");
  expect(loadConfig({ ...base, BANNED_WORDS_DIR: "" }).bannedWordsDir).toBe(def);
  expect(loadConfig({ ...base, BANNED_WORDS_DIR: "   " }).bannedWordsDir).toBe(def);
});
```

`tests/unit/wordfilter.test.ts`：

```ts
test("basic 模式加载到 0 个词时大声告警", async () => {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((s) => { lines.push(String(s)); });
  const f = await loadWordFilter({ mode: "basic", dir: join(tmpdir(), "wl-no-such-dir") });
  expect(f.size).toBe(0);
  expect(lines.some((l) => l.includes("0 words"))).toBe(true);
  spy.mockRestore();
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/unit/config.test.ts tests/unit/wordfilter.test.ts`
预期：两条都 FAIL（空串返回 `""`；无 `0 words` 日志）。

- [ ] **步骤 3：修 config**

```ts
const bannedWordsDir = (env.BANNED_WORDS_DIR ?? "").trim();
// 空串是「未设置」，不是「当前目录」：.env.example 里的 `BANNED_WORDS_DIR=` 必须落到默认目录。
bannedWordsDir: bannedWordsDir === "" ? join(process.cwd(), "data/banned") : bannedWordsDir,
```

顶部 `import { join } from "node:path";`。

- [ ] **步骤 4：修 wordfilter 告警**

`loadWordFilter` 末尾：

```ts
const filter = buildWordFilter(words, opts.allow ?? []);
if (opts.mode !== "off" && filter.size === 0) {
  // 过滤表为空等于没有审核：必须显眼，否则会把「配了 basic」误当成「在拦」。
  console.error(`[wordfilter] 0 words loaded (mode=${opts.mode}, dir=${opts.dir})`);
}
return filter;
```

同时把 `readWordDir` 的 `unreadable` 日志改成同一前缀格式 `[wordfilter] wordlist dir unreadable: <dir>`（去掉逗号后的英文），与上面保持可 grep 的一致前缀。

- [ ] **步骤 5：更新 `.env.example` 注释**

`BANNED_WORDS_DIR=` 行注释改为：`# 留空 = <cwd>/data/banned；basic/strict 依赖该目录下的 basic/ 与 strict/ 子目录`。

- [ ] **步骤 6：运行确认通过**

运行：`bun test && bun run typecheck`
预期：全绿。

- [ ] **步骤 7：Commit**

```bash
git add -A
git commit -m "fix(配置): BANNED_WORDS_DIR 空串回落默认目录，零词时告警"
```

---

### 任务 3：purge 令牌不可跨窗口重放（A3）

**文件：**
- 修改：`src/lib/purge.ts`（`PurgeTokenVerdict` 带 `exp`）
- 修改：`src/routes/admin.ts:280-292`（nonce 记到 `exp` 窗口）
- 修改：`src/lib/repo.ts`（`clearData` 清除 rate_limits 时保留 `purge_used`）
- 测试：`tests/unit/purge.test.ts`、`tests/integration/app.admin.test.ts`

- [ ] **步骤 1：写失败测试（跨窗口重放）**

在 `tests/integration/app.admin.test.ts` 追加（沿用文件里的登录/预检 helper）：

```ts
test("同一 purge 令牌跨 60s 窗口重放仍被拒", async () => {
  const { app, cleanup } = await makeApp();
  const cookie = await login(app);
  // 把时钟停在窗口边界前 100ms，预检后跨过边界再执行两次。
  setSystemTime(new Date("2026-01-01T00:00:59.900Z"));
  const pv = await (await app.fetch(jsonPost("/api/admin/purge/preview", { scope: "chat" }, cookie))).json();
  setSystemTime(new Date("2026-01-01T00:01:00.100Z"));
  const body = { scope: "chat", confirm: pv.confirm_phrase, secret: SECRET, token: pv.token };
  const first = await app.fetch(jsonPost("/api/admin/purge", body, cookie));
  expect(first.status).toBe(200);
  const second = await app.fetch(jsonPost("/api/admin/purge", body, cookie));
  expect(second.status).toBe(400);
  expect((await second.json()).error.code).toBe("invalid_token");
  setSystemTime();
  await cleanup();
});
```

再把 `tests/unit/purge.test.ts` 的 `ok` 判定补上 `exp`：

```ts
expect(v.ok && v.exp).toBeGreaterThan(Date.now());
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/integration/app.admin.test.ts -t "重放"`
预期：FAIL，第二次返回 200（跨窗口后 nonce 主键不同）。

- [ ] **步骤 3：让 verdict 带出 exp**

`src/lib/purge.ts`：

```ts
export type PurgeTokenVerdict =
  | { ok: true; nonce: string; exp: number }
  | { ok: false; reason: PurgeTokenReason };
```

`verifyPurgeToken` 增加 `if (typeof p.exp !== "number") return { ok: false, reason: "invalid_token" };`，并返回 `{ ok: true, nonce: p.nonce, exp: p.exp }`。

- [ ] **步骤 4：admin 用 exp 作为窗口**

`src/routes/admin.ts`：

```ts
// nonce 记在「令牌过期时刻」这个固定窗口：重放在任何时间点都命中同一主键，
// 而 window_start 在未来，清理逻辑（< now-2h）不会提前删掉它。
const used = await repo.rateHit("purge_used", verdict.nonce, verdict.exp);
```

删除不再使用的 `windowStartFor` import（若 `purgeRateGate` 仍用它则保留，按 `rg windowStartFor src/routes/admin.ts` 结果决定）。

- [ ] **步骤 5：`clearData("full")` 保留 nonce 行**

`src/lib/repo.ts` 增加：

```ts
/** rate_limits 表里 purge_used 是安全账本，清库不能连它一起清（否则令牌可重放）。 */
const DELETE_RATES_KEEP_NONCE = "DELETE FROM rate_limits WHERE bucket <> 'purge_used'";
```

- `SqliteRepo.clearData` 与 `PostgresRepo.clearData` 的表循环改为：`const s = t === "rate_limits" ? DELETE_RATES_KEEP_NONCE : DELETE_ALL_SQL[t];`
- `MemoryRepo.clearData` 对应改为：删除 rates 时保留 `bucket === "purge_used"` 的键。

- [ ] **步骤 6：补 full 档重放测试**

在 `tests/integration/app.admin.test.ts` 追加：

```ts
test("full 清空后，同一令牌仍被判为已使用", async () => {
  // 预检 full → 执行成功 → 再执行同一 body → 400 invalid_token
});
```

（断言与步骤 1 相同，scope 换成 `full`。）

- [ ] **步骤 7：运行确认通过**

运行：`bun test && bun run typecheck`
预期：全绿。

- [ ] **步骤 8：Commit**

```bash
git add src tests
git commit -m "fix(安全): purge 单次令牌记在未来窗口并豁免清库，杜绝重放"
```

---

### 任务 4：bootstrap 只作用于 `/api/*`（A5）

**文件：**
- 修改：`src/app.ts:63`（`app.use("*"` → `app.use("/api/*"`）
- 测试：`tests/integration/app.pages.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
test("DB 启动失败时静态页仍可访问，/api 返回 503", async () => {
  const { repo, cleanup } = await makeRepo("memory");
  (repo as any).bootstrap = async () => { throw new Error("db down"); };
  const app = createApp({ cfg: testCfg(), repo });
  const page = await app.fetch(new Request("http://x/demo.html"));
  expect(page.status).toBe(200);
  expect(page.headers.get("cache-control")).toContain("s-maxage=300");
  const api = await app.fetch(new Request("http://x/api/meta"));
  expect(api.status).toBe(503);
  await cleanup();
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/integration/app.pages.test.ts -t "静态页仍可访问"`
预期：FAIL，页面返回 503。

- [ ] **步骤 3：改中间件挂载点**

`src/app.ts`：把 `app.use("*", async (c, next) => {` 改成 `app.use("/api/*", async (c, next) => {`，注释同步改为「Bootstrap 失败只影响 API；静态页不碰存储，DB 抖动时仍要能打开」。

- [ ] **步骤 4：运行确认通过**

运行：`bun test && bun run typecheck`
预期：全绿（既有 503 相关测试仍覆盖 `/api/*`）。

- [ ] **步骤 5：Commit**

```bash
git add src/app.ts tests/integration/app.pages.test.ts
git commit -m "fix(可用性): 存储故障不再拖垮静态页，bootstrap 仅作用于 /api"
```

---

### 任务 5：删消息与广播原子化（A6 / E3）

**文件：**
- 修改：`src/lib/repo.ts`（接口 + 三实现；替换 `softDeleteMessage`）
- 修改：`src/routes/admin.ts`（DELETE 消息路由）
- 测试：`tests/integration/repo.test.ts`（契约）、`tests/integration/app.admin.test.ts`

- [ ] **步骤 1：写失败契约测试**

在 `tests/integration/repo.test.ts` 的契约套件里加：

```ts
test("softDeleteMessageAndEvent：删成功才写 delete 事件，重复删除不再写", async () => {
  const { messageId } = await repo.sendMessageAndEvent({ client_id: CID, nick: "n", text: "bye", created_at: 1 });
  expect(await repo.softDeleteMessageAndEvent(messageId, "admin", 2)).toBe(true);
  const ev = await repo.eventsSince(0, 50);
  const del = ev.filter((e) => e.type === "delete");
  expect(del).toHaveLength(1);
  expect(JSON.parse(del[0].payload)).toEqual({ id: String(messageId) });
  expect(await repo.softDeleteMessageAndEvent(messageId, "admin", 3)).toBe(false);
  expect((await repo.eventsSince(0, 50)).filter((e) => e.type === "delete")).toHaveLength(1);
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/integration/repo.test.ts -t "softDeleteMessageAndEvent"`
预期：FAIL，`repo.softDeleteMessageAndEvent is not a function`。

- [ ] **步骤 3：实现三方言版本**

接口：

```ts
/** 单事务：先软删（仅当未删过），改到行才写 delete 事件，返回是否真的删了。 */
softDeleteMessageAndEvent(id: number, by: string, at: number): Promise<boolean>;
```

- `SqliteRepo`：`const tx = await this.c.transaction("write")` → `tx.execute({ sql: SQL.softDel, args: [at, by, id] })` → 若 `rowsAffected === 0` 则 `rollback()` 并 `return false` → 否则 `tx.execute({ sql: SQL.insEvent, args: ["delete", JSON.stringify({ id: String(id) }), at] })` → `commit()` → `true`；catch 里 `rollback().catch(() => {})` 后抛出。
- `PostgresRepo`：`this.sql.begin(async (tx) => { const r = await tx.unsafe(...toPgParams(SQL.softDel, [at, by, id])); if (!r.count) return false; await tx.unsafe(...toPgParams(SQL.insEvent, ["delete", payload, at])); return true; })`。
- `MemoryRepo`：复用其 `softDeleteMessage` 的逻辑；仅当原行未删时置 `deleted` 并 push 一条 delete 事件。
- 删除旧的 `softDeleteMessage`（`rg -n softDeleteMessage src tests` 确认无残留调用后）。

- [ ] **步骤 4：admin 路由改单调用**

`src/routes/admin.ts` 的 `DELETE /api/admin/messages/:id`：

```ts
const ok = await repo.softDeleteMessageAndEvent(id, "admin", Date.now());
if (!ok) return jsonError(c, 404, "not_found");
return c.body(null, 204);
```

删除原先的 `insertEvent("delete", ...)` 调用。

- [ ] **步骤 5：运行确认通过**

运行：`bun test && bun run typecheck`
预期：全绿。

- [ ] **步骤 6：Commit**

```bash
git add src tests
git commit -m "fix(数据一致性): 删消息与 delete 事件合并为单事务"
```

---

### 任务 6：请求体大小上限（A7）

**文件：**
- 修改：`src/lib/copy.ts`（新增错误码 `payload_too_large`）
- 修改：`src/lib/http.ts`（`readJsonBody`）
- 修改：`src/routes/chat.ts`、`src/routes/admin.ts`（5 处读体点）
- 文档：`docs/api.md`（错误表加 413）
- 测试：`tests/unit/http.test.ts`、`tests/integration/app.chat.test.ts`

- [ ] **步骤 1：写失败测试**

`tests/unit/http.test.ts` 加：

```ts
test("readJsonBody：超过 16KB 直接 tooLarge，不解析 JSON", async () => {
  const big = JSON.stringify({ text: "x".repeat(20_000) });
  const req = new Request("http://x/api/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: big,
  });
  const r = await readJsonBody(fakeContext(req));
  expect(r).toEqual({ ok: false, tooLarge: true });
});
```

（`fakeContext` 用文件里已有的最小 Context 桩；若没有，直接对 `app.fetch` 断言 413。）

`tests/integration/app.chat.test.ts` 加：

```ts
test("超大请求体 → 413 payload_too_large", async () => {
  const { app, cleanup } = await makeApp();
  const res = await app.fetch(new Request("http://x/api/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CID, nick: "n", text: "x".repeat(20_000) }),
  }));
  expect(res.status).toBe(413);
  expect((await res.json()).error.code).toBe("payload_too_large");
  await cleanup();
});
```

- [ ] **步骤 2：运行确认失败**

运行：`bun test tests/integration/app.chat.test.ts -t "413"`
预期：FAIL，实际 400 `text_too_long`（说明先解析了 20KB）。

- [ ] **步骤 3：加错误码**

`src/lib/copy.ts` 的 `error` 对象里加 `payload_too_large: "请求体过大"`（`ErrCode` 自动包含它）。`docs/api.md` 的错误表加一行：`413 | payload_too_large | 请求体超过 16KB`。

- [ ] **步骤 4：实现 `readJsonBody`**

`src/lib/http.ts`：

```ts
export const MAX_BODY_BYTES = 16_384;

export type JsonBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; tooLarge: boolean };

/** 先看 content-length，再按字节数兜底：避免把任意大的 body 解析成对象。 */
export async function readJsonBody(c: Context<AppEnv>, maxBytes = MAX_BODY_BYTES): Promise<JsonBodyResult> {
  const ct = c.req.header("content-type") ?? "";
  if (!ct.includes("application/json")) return { ok: false, tooLarge: false };
  const len = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(len) && len > maxBytes) return { ok: false, tooLarge: true };
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return { ok: false, tooLarge: false };
  }
  if (new TextEncoder().encode(text).length > maxBytes) return { ok: false, tooLarge: true };
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, tooLarge: false };
    return { ok: true, body: v as Record<string, unknown> };
  } catch {
    return { ok: false, tooLarge: false };
  }
}
```

保留旧的 `readJson` 供本任务之外的调用点过渡，但在本任务里把所有调用点迁完并删除它（`rg -n "readJson\b" src` 应为空）。

- [ ] **步骤 5：迁移 5 处调用点**

`chat.ts` POST、`admin.ts` login / bans POST / purge / purge-preview 统一为：

```ts
const r = await readJsonBody(c);
if (!r.ok) return jsonError(c, r.tooLarge ? 413 : 400, r.tooLarge ? "payload_too_large" : "invalid_body");
const body = r.body;
```

后续对 `body` 的访问不再需要 `as` 断言。

- [ ] **步骤 6：运行确认通过**

运行：`bun test && bun run typecheck`
预期：全绿。

- [ ] **步骤 7：Commit**

```bash
git add -A
git commit -m "fix(安全): 请求体 16KB 上限，超限返回 413"
```
