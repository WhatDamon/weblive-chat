# weblive-chat 后端设计规格

- 日期：2026-09-09
- 状态：待审查（draft）
- 范围：后端服务 + API 契约 v0.1（不含前端应用，前端将依据本文档的契约接入）

## 1. 产品目标与约束

一个**免登录**实时聊天后端，可**直接部署到 Vercel**；面向**多个前端**提供同一套 API 契约，实时广播**在线人数**；管理员可在后端**封禁 IP**。

硬性约束：

1. **开源可复用**（MIT，Copyright (c) 2026 Damon Lu）——仓库内**不得存储任何敏感数据**（密钥、连接串一律走环境变量，只提交 `.env.example`）。
2. **Bun 管理**：本地开发 / 测试 / 脚本用 Bun；对外部署到 Vercel（Node Runtime 运行同一份代码，由 Hono 适配层保证双运行时兼容）。
3. 目标运行环境为 **Vercel Serverless：无状态**（每请求/每连接独立进程、随时回收、断线重连不保证同一实例）。

### 1.1 MVP 功能范围（本期）

- 匿名昵称聊天：实时收发、新进入自动加载最近历史
- 在线人数实时广播
- 管理员：口令登录、封禁/解封 IP、删除违规消息、查看在线数与消息
- 基础防滥用：限流、昵称/消息长度上限、可配置禁词
- 历史滚动保留（可配置）
- 存储超限时**自动收缩保留期 / 降级为仅实时模式**（§7.2）

### 1.2 非目标（明确不做，防范围蔓延）

多房间/频道、私聊、文件/图片上传、头像、昵称注册与占用、消息搜索、端到端加密、WebSocket 通道、历史无限期保留。

## 2. 决策摘要（ADR）

| # | 决策 | 理由 |
|---|------|------|
| D1 | 持久化默认 **Turso/libSQL**（`@libsql/client`，5 GB / 5 亿行读 / 1000 万行写/月，**无 CU 时间计费**）；**Neon Postgres 为可选 provider**（`DATABASE_URL` 以 `postgres://` 开头即切换） | 本方案 SSE 轮询会让 Neon 的 compute 7×24 活跃、几周烧完免费 CU 额度并被冻结（见 §7）；Turso 按读/写行数计费、空闲零成本，免费额度宽约 10×；Drizzle schema 用通用子集，两者可切 |
| D2 | **免登录**：客户端自持 `client_id`（UUID，无账号）；**管理员**：`ADMIN_SECRET` 口令换 HttpOnly 签名 Cookie（无状态，不落库） | 普通用户零摩擦；"保证有管理员"由**部署者配置**保证，仓库零敏感数据 |
| D3 | 实时通道 **SSE + POST**（事件流 `since` 游标自动续传；上行普通 POST） | Vercel 免费计划上 WS/SSE 都受函数时长上限约束，SSE 契约最干净、平台耦合最低；未来可把总线替换为 Redis/Ably 而**不改客户端契约** |
| D4 | 跨实例广播用 **Turso 作为总线**：`events` 出站表（outbox），每个事件流每秒轮询增量 | Serverless 无共享内存；轮询在 Turso 只计"行读取"、无 CU 时间炸弹；MVP 以 ~1 qps/流 的读放大换取零额外基础设施；负载路径见 §7 |
| D5 | 封禁持久化 `bans` 表，**每次发消息/开流实时查库校验**（不依赖进程内缓存一致性） | 封禁即时生效、跨实例一致；唯一索引点查成本可忽略 |
| D6 | 管理员删消息 = **软删占位**（`deleted_at` 置位、清空内容、保留 id/时间） | 避免他人回复上下文悬空；保留审计 |
| D7 | 历史**滚动保留**：天数（`HISTORY_RETENTION_DAYS`，默认 90）**与行数上限双控**（`HISTORY_MAX_ROWS`，默认 50 万），**自动逐级收缩**；出站表短期清理（1 小时） | 免费存储有上限，超限=写入失败；双控+自收缩避免静默事故，无需外部定时器 |
| D8 | 管理端 = 内置极简 `/admin` 静态页面（零构建）+ JSON 管理 API | 开箱即用，同时允许他人自建管理前端 |
| D9 | 防滥用 = 每 IP 限流（按消息/登录/开流分桶）+ 长度上限 + 可选禁词，全走环境变量 | 覆盖最小可信基线，配置化便于复用者自定 |
| D10 | 存储超限**自动降级**：历史持久化与实时广播解耦，必要时停写历史、仅实时（§7.2） | 免费额度耗尽应"降级保活"而非静默丢消息 |

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

1. 打开校验：IP 被封 → 推 `ban` 事件并关闭；登记 presence（upsert `last_seen`）。
2. 每 ~1s：`SELECT * FROM events WHERE id > since ORDER BY id LIMIT 100` → 按类型推送；成功后游标前移。兜底重连由**客户端**用 `since` 完成。
3. 每 ~10s：upsert 自身 presence（TTL 45s，超时即视为离线）。
4. 每 ~5s：`SELECT COUNT(*) FROM presence WHERE last_seen > now() - 45s` → 推 `presence` 事件。
5. 推送间隔内发送 SSE 注释行（`: ping`）保活。
6. 关闭/异常时删除或令自身 presence 行过期（靠 TTL，不依赖优雅关闭）。

**发消息路径**：POST → 校验（封禁点查 → 限流 → 长度/禁词）→ **必写** `events` 出站行（实时流唯一依赖）→ 按持久化模式**可选写** `messages`（§7.2）→ 返回 `201`。各事件流于下一次轮询收到并广播。

> 每次读在 Turso 计为"行读取"（增量轮询通常返回极少量行，成本极低）；Neon 作为可选 provider 时其 CU 时间语义见 §7.1。

## 4. 数据模型

所有 JSON 中的 `id`/游标一律以**字符串**序列化（BIGINT 超出 JS 安全整数）。

```sql
-- 消息（历史主表，滚动保留）
messages (
  id         BIGSERIAL PRIMARY KEY,        -- 单调游标
  client_id  UUID        NOT NULL,
  nick       TEXT        NOT NULL,
  text       TEXT        NOT NULL,          -- 纯文本，服务端仅做 trim/控制符清洗
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,                   -- 软删占位
  deleted_by TEXT
);

-- 出站事件总线（各事件流轮询；短期保留 1h）
events (
  id         BIGSERIAL PRIMARY KEY,
  type       TEXT NOT NULL,                 -- message | delete | ban | notice
  payload    JSONB NOT NULL,                -- message: 完整行快照；delete: {message_id}；ban: {ip, reason}；notice: {kind, ...}
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 在线状态（presence 心跳表）
presence (
  client_id UUID PRIMARY KEY,
  last_seen TIMESTAMPTZ NOT NULL            -- 索引用于 COUNT
);
CREATE INDEX ON presence (last_seen);

-- 封禁（持久化，唯一 IP）
bans (
  id         BIGSERIAL PRIMARY KEY,
  ip         TEXT NOT NULL UNIQUE,          -- MVP 精确匹配（规范化存储）；CIDR/前缀后置
  reason     TEXT NOT NULL,
  banned_by  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

迁移由 Drizzle 管理（SQL 迁移文件入库），`bun run db:migrate` 执行；部署者自行在目标库跑一次。

## 5. API 契约 v0.1（草案）

约定：时间均为 ISO 8601 UTC；错误统一信封 `{"error": {"code": string, "message": string, "retry_after_ms"?: number}}`；创建/更新类管理接口要求 `Content-Type: application/json`（配合 SameSite=Lax 防 CSRF）。

### 5.1 公开端点（聊天，免登录）

| 端点 | 说明 |
|---|---|
| `GET /api/meta` | 轻量配置：`{limits:{nick_max,text_max,retention_days}, presence:{ttl_s}}`（无 DB 依赖，供前端校验与展示） |
| `GET /api/messages?before=<id>&limit=50` | 历史回溯，newest-first，默认最近 50（≤200）；软删消息返回占位；`ephemeral` 模式返回 `{messages: [], mode: "ephemeral"}` |
| `GET /api/messages?since=<id>&limit=200` | 增量补齐（gap-sync，oldest-first；与事件流事件去重由客户端按 id 处理） |
| `POST /api/messages` | body `{client_id, nick, text}` → `201 {id, created_at}`；`403 banned`（含 reason）／`429`／`400` |
| `GET /api/stream?since=<id\|0>` | SSE 事件流（`text/event-stream`） |

SSE 事件类型：

| event | data | 语义 |
|---|---|---|
| `message` | `{id, client_id, nick, text, created_at}` | 新消息（含自己发的，按 id 去重） |
| `delete` | `{message_id}` | 某消息被管理员删除 → 前端替换为占位 |
| `presence` | `{online: number}` | 在线人数（45s TTL 窗口） |
| `notice` | `{kind: "history_mode", mode}` | 持久化模式变化（如自动降级到 `ephemeral`）→ 前端可提示 |
| `ban` | `{reason}` | 本连接 IP 被封 → 收到后前端停止并提示 |
| `: ping`（注释行） | — | 保活 |

### 5.2 管理端点（需会话 Cookie）

| 端点 | 说明 |
|---|---|
| `POST /api/admin/login` | body `{password}`；成功 → 置 `wl_admin` HttpOnly Cookie（HMAC 签名，默认 12h） |
| `GET /api/admin/session` | 校验 Cookie → `{admin: true}` |
| `POST /api/admin/logout` | 清除 Cookie |
| `GET /api/admin/bans?limit&offset` | 封禁列表（倒序，可翻页） |
| `POST /api/admin/bans` | body `{ip, reason}` → 创建；重复返回 `409` |
| `DELETE /api/admin/bans/:ip` | 解封 |
| `GET /api/admin/messages?before&limit` | 查看消息（含已软删标记） |
| `DELETE /api/admin/messages/:id` | 软删 → 写 `delete` 出站事件 |
| `GET /api/admin/stats` | `{online, messages_total, messages_retained, history: {mode, retention_days, estimate_bytes}}` —— 暴露存储用量与当前持久化模式，超限前给预警 |

Cookie 安全：`HttpOnly; SameSite=Lax; Secure`（生产）；`ADMIN_SECRET` 启动时校验（生产缺失/过短即拒绝启动，错误码 `not_configured` 引导部署者）。

### 5.3 状态码速查

`200/201/204`、`400`（校验失败 code 细分）、`401`（口令错/会话失效）、`403 banned`、`404`、`409`（重复封禁）、`429`（限流 + `retry_after_ms`）、`500`、`503 not_configured`（缺 DATABASE_URL）、`503 db_unavailable`（存储冻结/不可用，见 §7.2 Neon 语义）。

## 6. 防滥用与安全（MVP 基线）

- **限流**（每 IP 分桶，落库 `ON CONFLICT` upsert）：消息 10 条/10s 且 300 条/h；登录 5 次/5min；开流 20 次/min。
- **长度/格式**：nick ≤ 24 字符；text ≤ 2000 字符；均 trim + 去控制字符；`client_id` 须为合法 UUID。
- **禁词**：`BANNED_WORDS`（逗号分隔，可选），命中 `400`。
- **IP 来源**：`x-forwarded-for` 首跳（Vercel 注入），本地开发回退请求 IP；入库前规范化。
- **CORS**：`CORS_ORIGINS` 逗号分隔白名单（默认 `*`，公开聊天端点）；管理端点仅同源（Cookie 机制天然同源约束）。
- **存储安全**：纯文本不存 HTML；XSS 为前端渲染责任（契约中明示）。
- **仓库**：无任何密钥；`.env.example` 为唯一模板。

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

### 7.2 自动收缩 / 降级（进 MVP）

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

- **封禁粒度**：MVP 精确 IP；后续加 CIDR/前缀匹配只涉及校验函数与索引，不改契约。

## 8. 测试策略

- **单元**：校验器（长度/禁词/UUID）、限流桶算法、会话签名/验签 —— 用内存实现 repository 接口，`bun test`。
- **集成**（需 `DATABASE_URL`，未配置则自动 skip）：消息收发落库、软删占位、封禁即时生效、presence 计数、事件流游标续传。本仓库提供接口抽象使测试可注入内存实现，CI 无外部依赖即可跑单元层。

## 9. 目录布局（规划）

```
src/
  index.ts            # Hono app（本地 serve + Vercel handler 双入口）
  routes/chat.ts      # 公开端点 + SSE 事件流
  routes/admin.ts     # 管理 JSON API
  routes/admin-ui.ts  # 内置 /admin 静态页
  lib/storage.ts      # Turso/libSQL 默认 driver；DATABASE_URL 以 postgres:// 开头则切 Neon
  lib/schema.ts migrate.ts   # Drizzle schema + SQL 迁移（通用子集）
  lib/security.ts     # 口令、签名 Cookie、IP 解析
  lib/limits.ts       # 限流桶、校验、禁词
  lib/history.ts      # 保留策略 + 自动收缩/降级（§7.2）
  lib/stream.ts       # 事件流循环（可替换总线）
public/admin.html     # 管理页（零构建）
drizzle/              # SQL 迁移
.env.example  vercel.json  docs/api.md(实现期由本规格提取)
tests/                # bun test（单元为主）
```

## 10. 待实现期确认的技术细节（非契约）

- Vercel `maxDuration` 需按当前套餐在 `vercel.json` 配置并实测 SSE 断开时机。
- `@libsql/client` 在 Bun/Node 双运行时的行为；本地开发用文件版 SQLite（同一 schema）与远端 Turso 的一致性。
- Neon 可选 provider 驱动（`@neondatabase/serverless`）与 Bun 本地的兼容性验证（其 CU 语义已在 §7.1 文档化）。
- "平均行字节"估算与保留行数统计的实现成本（采样/`COUNT`），避免每次写入全表扫描。
- 清洗与模式评估的触发阈值（初定每 ~100 次写入评估一次）。
