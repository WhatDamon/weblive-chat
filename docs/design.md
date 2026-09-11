# weblive-chat 后端设计规格

- 日期：2026-09-09
- 状态：已定稿
- 范围：后端服务 + API 契约 v1 + 内置**零构建聊天页**（`public/demo.html`，同仓同 Vercel 项目、同源部署）；完整前端应用不在本期，前端依据本文档的契约接入

## 1. 产品目标与约束

一个**免登录**实时聊天后端，可**直接部署到 Vercel**；面向**多个前端**提供同一套 API 契约，实时广播**在线人数**；管理员可在后端**封禁 IP**。

硬性约束：

1. **开源可复用**（MIT，Copyright (c) 2026 Damon Lu）——仓库内**不得存储任何敏感数据**（密钥、连接串一律走环境变量，只提交 `.env.example`）。
2. **Bun 管理**：本地开发 / 测试 / 脚本用 Bun；对外部署到 Vercel（Node Runtime 运行同一份代码，由 Hono 适配层保证双运行时兼容）。
3. 目标运行环境为 **Vercel Serverless：无状态**（每请求/每连接独立进程、随时回收、断线重连不保证同一实例）。

### 1.1 功能范围

- 匿名昵称聊天：实时收发、新进入自动加载最近历史
- 在线人数实时广播
- 管理员：口令登录、封禁/解封 IP、删除违规消息、查看在线数与消息
- 基础防滥用：限流、昵称/消息长度上限、可配置禁词
- 历史滚动保留（可配置）
- 存储超限时**自动收缩保留期 / 降级为仅实时模式**（§7.2）
- 内置**聊天页**：`/demo.html`（零构建原生、同源）——昵称收发、历史加载、在线人数、断线自动重连；封禁与删除由管理后台 `/admin` 负责

### 1.2 非目标（明确不做，防范围蔓延）

多房间/频道、私聊、文件/图片上传、头像、昵称注册与占用、消息搜索、端到端加密、WebSocket 通道、历史无限期保留。

## 2. 决策摘要（ADR）

| # | 决策 | 理由 |
|---|------|------|
| D1 | 持久化由 **`DB_PROVIDER`（sqlite \| postgres）显式选择**，配 `DATABASE_URL`：SQLite 系 = 本地 `file:`（开发/测试）或远程 Turso（生产）；Postgres 系 = 任意实例（Neon / Supabase / 自托管）。默认 `sqlite` + Turso | 目标"手动自选 SQLite/PostgreSQL"= 配置切换而非代码分叉；见 §4.1 矩阵与 §7.3；Turso 免费档无 CU 时间计费，Neon 有（§7.1） |
| D2 | **免登录**：客户端自持 `client_id`（UUID，无账号）；**管理员**：`ADMIN_SECRET` 口令换 HttpOnly 签名 Cookie（无状态，不落库） | 普通用户零摩擦；"保证有管理员"由**部署者配置**保证，仓库零敏感数据 |
| D3 | 实时通道 **SSE + POST**（事件流 `since` 游标自动续传；上行普通 POST） | Vercel 免费计划上 WS/SSE 都受函数时长上限约束，SSE 契约最干净、平台耦合最低；未来可把总线替换为 Redis/Ably 而**不改客户端契约** |
| D4 | 跨实例广播用 **Turso 作为总线**：`events` 出站表（outbox），每个事件流每秒轮询增量 | Serverless 无共享内存；轮询在 Turso 只计"行读取"、无 CU 时间炸弹；以 ~1 qps/流 的读放大换取零额外基础设施；负载路径见 §7 |
| D5 | 封禁 = **禁言不禁看**：持久化 `bans` 表，发消息时**实时查库校验**（跨实例一致、即时生效）；已开流不断、仍可旁观，命中 IP 的流收到提示事件 | 误伤（同 IP 无辜用户/NAT）影响最小化；强制层 = 禁发 + 限流 |
| D6 | 管理员删消息 = **软删占位**（`deleted_at` 置位、清空内容、保留 id/时间） | 避免他人回复上下文悬空；保留审计 |
| D7 | 历史**滚动保留**：天数（`HISTORY_RETENTION_DAYS`，默认 90）**与行数上限双控**（`HISTORY_MAX_ROWS`，默认 50 万），**自动逐级收缩**；出站表短期清理（1 小时） | 免费存储有上限，超限=写入失败；双控+自收缩避免静默事故，无需外部定时器 |
| D8 | 管理端 = 内置极简 `/admin` 静态页面（零构建）+ JSON 管理 API | 开箱即用，同时允许他人自建管理前端 |
| D9 | 防滥用 = 每 IP 限流（按消息/登录/开流分桶）+ 长度上限 + 可选禁词，全走环境变量 | 覆盖最小可信基线，配置化便于复用者自定 |
| D10 | 存储超限**自动降级**：历史持久化与实时广播解耦，必要时停写历史、仅实时（§7.2） | 免费额度耗尽应"降级保活"而非静默丢消息 |
| D11 | 可移植性规则（§4.1）：整数自增主键 + TEXT 载荷 + **时间一律 epoch ms 整数、应用层算好传参**，SQL 层禁方言写法（`now()`/`interval`/JSONB 等） | 否则换库要改代码；"跨方言子集 + 显式 provider"是复用的根基 |
| D12 | 可选**来源白名单**：`ALLOWED_ORIGINS` 未设置 = 开放（CORS `*`）；设置后 fail-closed（不在名单的跨源请求 `403 origin_not_allowed`）；无 Origin 直连默认放行，`REQUIRE_ORIGIN=1` 可收紧（§6.1） | 防第三方站点套壳/跨站借力；明确其**非认证**，强制手段仍靠封禁 + 限流 |
| D13 | 建表 = **启动幂等自建**：`DB_MIGRATE_ON_BOOT`（默认开）首次请求前 `CREATE TABLE IF NOT EXISTS`；schema 演进期后再引入版本化 SQL 迁移 | "直接部署到 Vercel" 零手动步骤；当前 schema 小，自建表足够 |
| D14 | 历史回溯默认**全量开放**（可翻页）；`HISTORY_MAX_BACKFILL` 可限回溯深度/关闭（0=不限制）。免登录下历史 = 公开存档，README 明示合规风险 | 开箱即用（新访客补上下文）；部署者按需收紧 |
| D15 | 内置**零构建聊天页**（同源 `public/demo.html`，随本 Vercel 项目部署）；`/api/meta` 暴露 `client_ip` 供前端展示本机 IP | 同源免 CORS、部署后即可线上验证 SSE+DB；前端示范 since 重连与缺口补齐；`client_ip` 是本期唯一契约扩展 |
| D16 | 存储层 = **手写可移植 SQL 仓库**（不引入 ORM）：跨方言 SQL 子集 + 按 provider 维护的幂等 DDL（`lib/ddl.ts`/`lib/repo.ts`）；数据模型增加第 5 表 `rate_limits` 支撑原子限流计数 | 依赖最少，file:sqlite / Postgres 同一套集成测试双跑最稳；Serverless 无共享内存，限流计数必须落库原子自增（§4） |

## 3. 架构与数据流

```
┌─────────────┐  POST /api/messages    ┌──────────────────────────┐
│   前端 A     │──────────────────────▶│                          │
│ (网页/小程序) │                       │     Hono App (Bun 本地 /  │
│             │  GET /api/stream ◀─────│     Vercel Node Runtime)  │
└─────────────┘   (SSE 事件流)         │   chat / admin / admin-ui │
┌─────────────┐                        └────────────┬─────────────┘
│   前端 B     │─────────────────────────────────────┘   ▲
└─────────────┘  每流每秒轮询 events since 游标 ─────────┘ │
                                                     ▼
                                    ┌──────────────────────────────┐
                                    │  Turso / libSQL（可选 Neon）   │
                                    │  messages / events / bans /   │
                                    │  presence  （跨实例共享状态）   │
                                    └──────────────────────────────┘
```

**SSE 事件流内部循环**（每个连接 = 一个独立函数实例）：

1. 打开：登记 presence（upsert `last_seen`）。封禁语义为**禁言**（D5）：只拦截发消息，不拒绝/断开旁观流；本连接 IP 被禁言时收到 `ban` 提示事件（流保持打开）。
2. 每 ~1s：`SELECT * FROM events WHERE id > since ORDER BY id LIMIT 100` → 按类型推送；成功后游标前移。兜底重连由**客户端**用 `since` 完成。
3. 每 ~10s：upsert 自身 presence（TTL 45s，超时即视为离线）。
4. 每 ~5s：`SELECT COUNT(*) FROM presence WHERE last_seen > :cutoff`（cutoff = 当前 epoch ms − 45s，应用层算好）；**仅当人数相对上次变化时才推 `presence` 事件**（无变化不广播，避免周期无谓推送）。
5. 推送间隔内发送 SSE 注释行（`: ping`）保活。
6. 关闭/异常时删除或令自身 presence 行过期（靠 TTL，不依赖优雅关闭）。

**发消息路径**：POST → 校验（封禁点查 → 限流 → 长度/禁词）→ **必写** `events` 出站行（实时流唯一依赖）→ 按持久化模式**可选写** `messages`（§7.2）→ 返回 `201`。各事件流于下一次轮询收到并广播。

> 每次读在 Turso 计为"行读取"（增量轮询通常返回极少量行，成本极低）；Neon 作为可选 provider 时其 CU 时间语义见 §7.1。

## 4. 数据模型

**可移植性约定**：主键为整数自增（由 provider 专属 DDL 体现：PG `serial` / SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`，在保留上限内数值远小于 2³¹）；所有 JSON 中的 `id`/游标一律序列化为**字符串**；时间一律存 **epoch 毫秒整数**、由应用层计算与传参，SQL 层不出现 `now()`/`interval`/时间类型函数（详见 §4.1）。

```sql
-- 消息（历史主表，滚动保留）
messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT, -- 单调游标（SQLite DDL；PG 用 serial）
  client_id  TEXT        NOT NULL,              -- UUID 字符串（格式应用层校验）
  nick       TEXT        NOT NULL,
  text       TEXT        NOT NULL,              -- 纯文本，服务端仅做 trim/控制符清洗
  created_at INTEGER     NOT NULL,              -- epoch ms（应用层写入）
  deleted_at INTEGER,                           -- epoch ms；软删占位
  deleted_by TEXT
);

-- 出站事件总线（各事件流轮询；短期保留 1h）
events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT, -- 单调游标
  type       TEXT NOT NULL,                 -- message | delete | ban | notice
  payload    TEXT NOT NULL,                 -- JSON 字符串（从不查询内部，故不用 JSONB）；载荷见 §5
  created_at INTEGER NOT NULL               -- epoch ms
);

-- 在线状态（presence 心跳表）
presence (
  client_id TEXT PRIMARY KEY,               -- UUID 字符串
  last_seen INTEGER NOT NULL                -- epoch ms；索引用于 COUNT
);
CREATE INDEX ON presence (last_seen);

-- 封禁（持久化，唯一 IP）
bans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip         TEXT NOT NULL UNIQUE,          -- 精确匹配（规范化存储）；CIDR/前缀后置
  reason     TEXT NOT NULL,
  banned_by  TEXT NOT NULL,
  created_at INTEGER NOT NULL               -- epoch ms
);

-- 限流计数（每 IP × 桶 × 固定窗口；原子自增，过期行随清洗删除）
rate_limits (
  bucket       TEXT NOT NULL,          -- msg | stream | login
  scope        TEXT NOT NULL,          -- 规范化 IP
  window_start INTEGER NOT NULL,       -- 窗口起点 epoch ms（应用层按 60s 对齐）
  count        INTEGER NOT NULL,
  PRIMARY KEY (bucket, scope, window_start)
);
```

> presence 行 TTL 过期后**不自动删除**（每 client 一行、upsert 覆盖）；清洗节点顺带删除 `last_seen` 早于 TTL 数倍的过期行，防离线 client 累积（§7.2）。

迁移/建表：**启动幂等自建**（D13）——`DB_MIGRATE_ON_BOOT`（默认开）首次请求前执行 `CREATE TABLE IF NOT EXISTS`；表定义见 §9 `lib/ddl.ts`（按 provider 维护，本实现期不引入 ORM，见 D16）；schema 演进期后再引入版本化 SQL 迁移（`bun run db:migrate`）。

### 4.1 Provider 矩阵与可移植性规则

**Provider 选择**（两个环境变量，仓库不存任何密钥）：

| 用途 | `DB_PROVIDER` | `DATABASE_URL` | Vercel 生产可用 |
|---|---|---|---|
| 本地开发 / 测试 | `sqlite` | `file:./data/dev.db` | —（仅本机） |
| 本地纯内存演示 / 测试（重启即空） | `memory` | 无需（忽略） | ❌（仅单实例） |
| 生产 SQLite | `sqlite` | `libsql://…`（Turso） | ✅（远程） |
| 生产 / 自托管 Postgres | `postgres` | `postgres://…`（Neon / Supabase / 自建） | ✅ |

> ⚠️ **Vercel 函数文件系统是临时的** —— `file:` 型 SQLite 只能用于本地开发与测试，**禁止作为 Vercel 生产存储**；生产 SQLite 必须走远程（Turso 等）。
>
> ⚠️ **`memory` 模式（实现期新增，见 §11）** —— 进程内实现 Repo 接口（无外部依赖、零持久化、重启即空），仅供本地/单实例演示与测试。Serverless 多函数实例无共享内存，跨实例收不到彼此消息且数据随实例回收——**不适用于 Vercel/生产**，`NODE_ENV=production` 下设置 `DB_PROVIDER=memory` 直接拒绝启动。

**可移植性规则**（D11）：

1. 主键一律整数自增，由 provider 专属 DDL 体现（PG `serial` / SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`），**不写 `bigserial`/`BIGSERIAL`**。
2. 字符串列一律 `TEXT`（`client_id` 的 UUID 格式在应用层校验）；结构化载荷一律 `TEXT` 存 JSON 字符串（从不查询内部，无需 JSONB）。
3. 时间一律 **epoch ms 整数**：写入时应用层取 `Date.now()`，比较（presence TTL、保留清理）由应用层算好边界再以参数传入；SQL 层禁止 `now()`/`interval`/方言时间函数。ISO 8601 格式化在应用层输出。
4. 换 provider = 改 `DB_PROVIDER` + `DATABASE_URL`，启动时自动重建表（D13）——**业务与 API 契约代码零改动**；此约束纳入 §8 测试矩阵（同一套用例双库跑）。

## 5. API 契约 v0.1（草案）

约定：时间均为 ISO 8601 UTC；错误统一信封 `{"error": {"code": string, "message": string, "retry_after_ms"?: number}}`；创建/更新类管理接口要求 `Content-Type: application/json`（配合 SameSite=Lax 防 CSRF）。

### 5.1 公开端点（聊天，免登录）

| 端点 | 说明 |
|---|---|
| `GET /api/meta` | 轻量配置：`{limits:{nick_max,text_max,retention_days}, presence:{ttl_s}, client_ip}`（无 DB 依赖；`client_ip` = 服务端视角当前请求 IP、已规范化，供前端展示） |
| `GET /api/messages?before=<id>&limit=50` | 历史回溯，newest-first，默认最近 50（≤200）；回溯深度默认全量，`HISTORY_MAX_BACKFILL` 可限深/关闭；软删消息返回占位；`ephemeral` 模式返回 `{messages: [], mode: "ephemeral"}` |
| `GET /api/messages?since=<id>&limit=200` | 增量补齐（gap-sync，oldest-first；与事件流事件去重由客户端按 id 处理） |
| `POST /api/messages` | body `{client_id, nick, text}` → `201 {id, created_at}`；`403 banned`（含 reason）／`429`／`400` |
| `GET /api/stream?since=<id\|0>&client_id=<uuid>` | SSE 事件流（`text/event-stream`）。`client_id`（可选，须为合法 UUID）用于 presence 归因与多标签去重：缺省则每连接计入一次心跳 |

SSE 事件类型：

| event | data | 语义 |
|---|---|---|
| `message` | `{id, client_id, nick, text, created_at}` | 新消息（含自己发的，按 id 去重） |
| `delete` | `{id: string}` | 某消息被管理员删除 → 前端替换为占位（字段名与 MessageView.id 一致；早期草稿写作 `{message_id}`，实现收敛为 `{id}`，见 §11） |
| `presence` | `{online: number}` | 在线**人数**（45s TTL 窗口；按 `client_id` 去重，同浏览器多标签 = 1） |
| `notice` | `{kind: "history_mode", mode, retention_days}` | 持久化模式变化（如自动降级到 `ephemeral`；含当前生效保留天数）→ 前端可提示 |
| `ban` | `{reason}` | 本连接 IP 被**禁言**（仅推给命中 IP 的流）→ 前端提示"你已被禁言"；流保持打开可继续旁观 |
| `: ping`（注释行） | — | 保活 |

**流与游标语义**：`/api/stream` 的 `since` 指向 **`events.id`**（该表保留 1h），`/api/messages?since=` 指向 **`messages.id`** —— 两个独立 id 空间。客户端流程：开流（`since=0` 或上次游标）→ 回溯/gap-sync 走 messages → 事件按消息 id 去重。**回退规则**：若断线超过 events 保留期导致旧游标空转（`WHERE id > since` 无结果且 `since` 落后于当前最小 id），将游标重置为当前最大 `events.id`，并用 `GET /api/messages?since=<本地最新 messages.id>` 补齐缺口。

### 5.2 管理端点（需会话 Cookie）

| 端点 | 说明 |
|---|---|
| `POST /api/admin/login` | body `{secret}`（对照 `ADMIN_SECRET`）；成功 → 置 `wl_admin` HttpOnly Cookie（HMAC 签名，有效 `ADMIN_SESSION_DAYS` 默认 7d）；失败/超限 `401 invalid_secret` / `429 rate_limited`（登录限流 `LOGIN_RATE_PER_MIN=5`） |
| `GET /api/admin/me` | 校验 Cookie → `{authed: true}`（会话鉴权守卫，未认证/过期统一 `401 unauthorized`） |
| `POST /api/admin/logout` | 清除 Cookie |
| `GET /api/admin/bans?limit&offset` | 封禁列表（created_at 倒序，可翻页，limit 1..500） |
| `POST /api/admin/bans` | body `{ip, reason}` → 新增/覆盖；幂等 upsert：重复 → `200 {created: false}`（created 标志由 repo 双驱动返回，无 409） |
| `DELETE /api/admin/bans/:ip` | 解封（204/404） |
| `DELETE /api/admin/messages/:id` | 软删（占位行保留、text 清空、`deleted_by='admin'` 固定标识、不存操作者 IP）→ 写 `delete` 出站事件（payload 仅 `{id}`） |
| `GET /api/admin/stats` | `{online, messages_total, messages_retained, history: {mode, retention_days, estimate_bytes}}` —— 暴露存储用量与当前持久化模式，超限前给预警；读取时顺带触发维护刷新档位（借维护节拍，写/读共用同一计数器） |

注：管理端不再提供 `GET /api/admin/messages`（消息查看由公开 `GET /api/messages` 承担，软删标记同样透出）。

Cookie 安全：`HttpOnly; SameSite=Lax; Secure`（生产）；`ADMIN_SECRET` 在 `NODE_ENV=production` 且未设置时于启动阶段抛错拒绝（仅校验缺失、无长度下限，属启动错误而非 HTTP 响应码）。

### 5.3 状态码速查

`200/201/204`、`400`（校验失败 code 细分）、`401`（口令错/会话失效）、`403 banned` / `403 origin_not_allowed`（Origin 不在白名单）/ `403 missing_origin`（`REQUIRE_ORIGIN=1` 且请求无 Origin）、`404`、`429`（限流 + `retry_after_ms`）、`500`、`503 db_unavailable`（存储冻结/不可用，见 §7.2 Neon 语义）。

> 配置缺失不产生响应码：`DATABASE_URL`（postgres 形态）/`ADMIN_SECRET`（生产）等在启动/构建阶段由 `loadConfig` 直接抛错，无 `503 not_configured`。

## 6. 防滥用与安全

- **限流**（每 IP 分桶，落库 `ON CONFLICT` upsert，60s 固定窗口、epoch ms 对齐）：消息 10 条/min；登录 5 次/min；开流 20 次/min。（数值即 `config.ts` 默认值，可用环境变量覆盖。）
- **长度/格式**：nick ≤ 24 字符；text ≤ 1000 字符；均 trim + 去控制字符；`client_id` 须为合法 UUID。
- **禁词**：内置精选词库（`data/banned/basic/`，来源 Sensitive-lexicon MIT + 人工增补）+ `BANNED_WORDS` 显式词 + `BANNED_WORDS_ALLOW` 白名单；`BANNED_WORDS_MODE=off|basic|strict`。匹配在归一化文本上进行（NFKC/小写/去零宽与标点），防「赌　博」类插空绕过；词长下限 2 字；昵称与内容都检，命中 `400 banned_word`。不做整包导入的原因（误伤）与裁剪规则见 `data/banned/README.md`。
- **IP 来源**：`x-forwarded-for` 首跳（Vercel 注入），本地开发回退请求 IP；入库前规范化。
- **CORS / 来源白名单**：见 §6.1。管理端点仅同源（Cookie 机制天然同源约束）。
- **存储安全**：纯文本不存 HTML；XSS 为前端渲染责任（契约中明示）。
- **审计与隐私**：`deleted_by` 仅存固定标识（管理员无账号），不落操作者 IP；`bans` 表存 IP 属功能必需，README 提示合规。
- **仓库**：无任何密钥；`.env.example` 为唯一模板。

### 6.1 来源白名单（Origin allowlist）

> **定位与边界**：挡"第三方站点把你的 API 嵌进自家页面借力"与"跨站读取"；它**不是认证** —— 不带 Origin 的直连（curl/脚本/重放）无法靠它区分，强制手段仍是封禁 + 限流。

环境变量：`ALLOWED_ORIGINS`（逗号分隔的精确域名）；`REQUIRE_ORIGIN=1`（可选收紧，见下）。

| 配置 | 行为 |
|---|---|
| `ALLOWED_ORIGINS` 未设置 | **开放模式**：公开端点 CORS `*`；管理端点仍仅同源 |
| 设置名单（如 `https://a.com,https://b.com`） | **白名单模式（fail-closed）**：请求带 Origin 且不在名单 → `403 origin_not_allowed`；在名单 → 回显对应 `Access-Control-Allow-Origin` |
| 请求不带 Origin（同源 / 非浏览器 / curl） | 默认放行；`REQUIRE_ORIGIN=1` 时强制要求且必须在名单内（拒绝码 `403 missing_origin`，适合纯 API 部署） |

规则：

1. 精确匹配 `scheme://host[:port]`：忽略路径/query、去尾斜杠、小写主机；不做子串匹配；`https://*.a.com` 通配暂不支持（多域名直接列举）。
2. 名单含多个域名时，禁止 `Access-Control-Allow-Origin: *` 与 `Access-Control-Allow-Credentials` 同用；所有响应带 `Vary: Origin`，防 CDN 缓存错发。
3. 仅信 **Origin**，不信 `Referer`（可伪造、隐私策略下常缺失）。
4. 管理端点默认仅同源（Cookie 天然约束）；需自建跨源管理前端时，把该域名显式加入名单并启用 credentials 模式。
5. `GET /api/stream`（SSE，EventSource 跨源带 Origin）与 POST 走同一中间件闸口；本地开发将 `http://localhost:<port>` 加入名单。
6. 预检：OPTIONS 仅对名单内 Origin 放行并回 `Access-Control-Max-Age` 缓存预检结果。
7. 非目标：路径/参数级访问控制（应用鉴权职责，不属于来源限制）。

## 7. 容量与成本模型（含免费额度核算）

> **v0.1 修正**：初稿默认 Neon 并称"50 并发可承受"——**未计入 Neon 的 CU（compute 活跃小时）计费**。SSE 轮询会让 compute 7×24 活跃（≈720 CU-h/月，免费仅 ~100），持续在线几周即被**冻结到下个账单周期**。故默认存储改为 Turso（按读/写行数计费、空闲零成本），Neon 保留为可选 provider。

### 7.1 配额语义与预算数学

| 配额 | Turso 免费（默认） | Neon 免费（可选） | 耗尽时行为 |
|---|---|---|---|
| 时间型计费 | **无**——空闲零成本；轮询只计行读取 | ~100 CU-h/月；闲置 5 分钟才休眠 | Neon：**冻结至下个周期** |
| 存储 | 5 GB | 0.5 GB | **写入失败**（INSERT 报错） |
| 读 | 5 亿行读/月 | — | 超限拒绝 |
| 写 | 1000 万行写/月 | — | 超限拒绝 |

**预算数学（Turso）**：每消息含索引约 400B。5 GB ≈ 1200 万条；默认 `HISTORY_MAX_ROWS=500_000` 约 200MB，写健康。

- 5k 条/日 → 90 天仅 45 万条，不触顶，行读取余量充足（50 并发×1 qps ≈ 1.3 亿读/月 < 5 亿）。
- 写入是首个可能触顶的维度：每消息约 2–3 行写入（messages + events + 限流/心跳摊销）→ 1000 万行/月 ≈ **~10 万条消息/日**才到硬顶。
- Neon（若选用）：持续在线即烧 CU——请仅在低流量演示或启用付费档时使用；其存储超限语义与 Turso 相同（写失败）。
- **Provider 形态**（§4.1）：本地开发/测试用 `file:` SQLite 零成本；Vercel 生产用远程 Turso 或 Postgres（`file:` 型在 Vercel 上不持久，禁止作生产存储）。

### 7.2 自动收缩 / 降级

设计原则：**历史持久化与实时广播解耦** —— 发消息**必写** `events`（1h 自清理，实时流的唯一依赖）；**可选写** `messages`（历史）。持久化模式由"行数 × 天数"对配置上限**确定性推导**（所有实例读同一批数据得同一结论，无需共享状态）：

| mode | 触发 | 行为 |
|---|---|---|
| `full` | 未达上限 | 正常持久化 |
| `degraded_retention` | 保留行数接近 `HISTORY_MAX_ROWS` | 自动逐级缩短天数（90→30→10→3→1）并广播 `notice` |
| `ephemeral` | 到达硬顶 | **停写 `messages`**，仅 `events` 实时广播；`/api/messages` 返回 `mode:"ephemeral"`；`/api/admin/stats` 醒目提示 |

- 评估在"每 N 次写入"的维护点顺手执行（含清理过期行/出站行），无需外部 cron；`notice` 事件经出站表广播。
- 管理端 `stats` 暴露 `messages_retained / estimate_bytes / history.mode / retention_days`（估算 = 行数 × 平均行字节），超限前预警。
- Neon 冻结属不可恢复的外部停摆（无库可读，降级逻辑本身跑不起来）→ 统一 `503 db_unavailable`，文档引导部署者换 provider 或付费档。

### 7.3 演进阶梯（全程不改 API 契约）

| 阶段 | 触发信号 | 动作 | 影响 |
|---|---|---|---|
| S0 | 起步 | Turso 默认，零成本 | 行读/写余量充足 |
| S1 | 写入接近 1000 万行/月或读逼近 5 亿 | 启用总线模式（Ably/Pusher 免费档）：fan-out 与 presence 离开 DB，DB 只存历史 | 实时不再轮询 DB；读骤降 |
| S2 | 持续多人并发 / 长历史刚需 | Turso 付费或自托管 Postgres（Neon 可选） | ~$10–20/月级，部署者自选 |
| S3 | 规模化 | 专用 WS 服务器（Bun 自建） | 契约不变 |

任一阶段切 provider = 改 `DATABASE_URL` 一个值（schema 为通用子集），无代码结构变更。

- **封禁粒度**：精确 IP；后续加 CIDR/前缀匹配只涉及校验函数与索引，不改契约。

## 8. 测试策略

- **单元**（内存 repository，恒跑）：校验器（长度/禁词/UUID）、限流桶算法、会话签名/验签、来源白名单逻辑（精确匹配/预检/无 Origin/单域名 credentials）。
- **集成**（同一套用例，验证跨方言）：默认对**本地文件 SQLite**（`file:`）跑全部用例（零外部依赖）；当提供 Postgres `DATABASE_URL` 时对 **Postgres 再跑一遍**。覆盖：消息收发落库、软删占位、封禁即时生效、presence 计数、事件流游标续传。
- 实现期以 repository 抽象隔离方言差异；CI 无外部依赖即可跑单元 + 文件 SQLite 集成层。

## 9. 目录布局（规划）

```
src/
  index.ts            # Hono app（本地 serve + Vercel handler 双入口）
  routes/chat.ts      # 公开端点 + SSE 事件流
  routes/admin.ts     # 管理 JSON API
  routes/pages.ts     # 同源静态页：/demo.html、/admin、/ → /demo.html
  lib/config.ts       # 环境变量加载/校验/默认值（全部旋钮）
  lib/ddl.ts          # 按 provider 维护的幂等建表 DDL（sqlite / pg 两套）
  lib/repo.ts         # 手写可移植 SQL 数据访问层（方言差异隔离；含事务双写与引导）
  lib/security.ts     # 口令、签名 Cookie、IP 解析、来源白名单
  lib/validate.ts     # 昵称/文本清洗、UUID、禁词、长度与游标解析
  lib/limits.ts       # 限流判定（配 repo.rateHit 原子计数）
  lib/history.ts      # 保留策略 + 自动收缩/降级（§7.2）
  lib/stream.ts       # 事件流控制器（轮询/游标回退/presence 广播，可单测）
public/demo.html      # 聊天页（零构建、同源）
public/admin.html     # 管理页（零构建）
scripts/              # 演进期启用：版本化 SQL 迁移（不引入 ORM，见 D16）
.env.example（含 DB_PROVIDER、三种 URL、ALLOWED_ORIGINS、DB_MIGRATE_ON_BOOT、HISTORY_MAX_BACKFILL 示例）  vercel.json  docs/api.md(实现期由本规格提取)
tests/                # bun test（单元为主）
```

## 10. 上线前需实测的运行时细节（非契约）

- SSE 在 Vercel 实测：官方文档 Hobby 默认/最大时长均 300s（fluid compute），验证空闲不提前断流、断点重连与 presence TTL 衔接。
- 单函数部署形态实测：`src/index.ts` 默认导出 **Web handler 对象 `{ fetch(request) }`**（Vercel Node 运行时唯一接受的三种形态之一：`{ fetch }` / 具名 `GET|POST…` / 自带 `.fetch` 的框架实例）承接全部路由，`vercel.json` 用 `builds` + `@vercel/node`；本地 Bun.serve 同进程跑同一 app。
  - ⚠️ **入口导出形态**：必须是带 `fetch` 方法的对象（Vercel Node 运行时的 Web handler 约定）；裸函数导出会被当作旧式 `(req, res)` 处理器，响应永不下发（整站挂起至函数超时）。护栏见 `tests/integration/vercel-entry.test.ts`。
  - 模块顶层**不得出现 top-level await**（`@vercel/node` 产物可能转 CJS）；dev 入口改用 `void buildApp().then(...)`。
- 驱动实测：`@libsql/client`（file: 与 libsql://）与 `postgres.js` 在 Bun/Node 双运行时行为；本地 `file:` 与远端 Turso 的一致性。
- 发消息 events + messages 双写须在同一事务内（SQLite batch / PG begin），失败整体回滚。
- "平均行字节"估算与保留行数统计的实现成本（`COUNT` 每 ~100 次写入评估一次），避免每次写入全表扫描。
- 静态页随函数部署：`/demo.html`、`/admin` 由 Hono 同进程读取 `public/` 提供（同源）；Vercel 上将 `public/**` 打进函数文件系统（部署时验证）。

## 11. 实现说明（相对早期草稿的收敛点）

以下为落地后与早期草稿不一致或进一步明确之处：

- **events payload 构造于 repo 事务内**：`sendMessageAndEvent` 先插 `messages` 拿自增 id，再构造 `{id: String(messageId), client_id, nick, text, created_at}` 载荷并在同一事务内插 `events`（双写原子）。
- **SSE 支持可选 `client_id=<uuid>`**（presence 归因/多标签去重），缺失回落每连接 `anon-<uuid>`。
- **`ephemeral` 消息 id 形如 `e<eventId>`**：避开 `messages.id` 命名空间，杜绝 delete 事件误删直播消息。
- **`delete` 事件载荷为 `{id}`**（草案写作 `{message_id}`），与 MessageView.id 同字段。
- **管理契约**：登录 body `{secret}`、会话探测 `GET /api/admin/me → {authed:true}`、重复封禁幂等 upsert `200 {created:boolean}`（无 409）、会话有效 `ADMIN_SESSION_DAYS` 默认 7d；不再提供 `GET /api/admin/messages`（历史走公开端点）。
- **`/api/messages` 契约收紧**：`before`/`since` 互斥（400 invalid_body）；`limit` 缺省 50、1–200 夹取、非纯数字 400 invalid_cursor；游标/`limit` 上界夹取 `MAX_ID_BOUND`（2³¹−1，PG serial/int4 安全）。
- **messages 响应 `id` 一律字符串、`created_at` ISO 8601**；SSE 事件载荷 `created_at` 为 epoch ms 数字。
- **`rate_limits` 表落地**（D16 第 5 表）：`bucket × scope × window_start` 复合主键，`ON CONFLICT … count=count+1 RETURNING count` 原子计数（双方言同 SQL）。
- **存储层 = 手写可移植 SQL**（`lib/repo.ts` 双驱动 + `lib/ddl.ts` 按 provider 幂等 DDL；无 ORM）；`bans` 表以 `ip` 为 PRIMARY KEY（草案 §4 的独立 `id`+UNIQUE 收敛掉），保留 `banned_by` 审计列。
- **限流/长度默认值对齐**（§6）：消息 10/min、开流 20/min、登录 5/min（60s 固定窗口）；text ≤ 1000。
- **§10 待确认项结果**：双写事务（✓）、静态页随函数 `includeFiles`（✓）、`hono` 4.13 无 `node-serverless` 子路径 → `index.ts` 导出自持懒转发 handler（✓）、`Bun.serve idleTimeout` 上限 255（✓）、开流限流接线（✓）。**剩余仅云端实测**（Vercel 函数 300s/SSE 断线续传/`process.cwd()` 下 `public/` 落盘）——`docs/api.md` 已把断线重连列为客户端义务。
- **入口导出形态**：`export default { async fetch(request) }`（保留懒启动、无顶层 await）；形态护栏见 `tests/integration/vercel-entry.test.ts`。
