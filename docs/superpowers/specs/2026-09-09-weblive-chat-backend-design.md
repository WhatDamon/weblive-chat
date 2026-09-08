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

### 1.2 非目标（明确不做，防范围蔓延）

多房间/频道、私聊、文件/图片上传、头像、昵称注册与占用、消息搜索、端到端加密、WebSocket 通道、历史无限期保留。

## 2. 决策摘要（ADR）

| # | 决策 | 理由 |
|---|------|------|
| D1 | 持久化用 **Neon Postgres**（`@neondatabase/serverless` HTTP 驱动 + Drizzle ORM，迁移入库） | Vercel 上唯一可靠的持久层；serverless 驱动免连接池；免费额度足够 MVP |
| D2 | **免登录**：客户端自持 `client_id`（UUID，无账号）；**管理员**：`ADMIN_SECRET` 口令换 HttpOnly 签名 Cookie（无状态，不落库） | 普通用户零摩擦；"保证有管理员"由**部署者配置**保证，仓库零敏感数据 |
| D3 | 实时通道 **SSE + POST**（事件流 `since` 游标自动续传；上行普通 POST） | Vercel 免费计划上 WS/SSE 都受函数时长上限约束，SSE 契约最干净、平台耦合最低；未来可把总线替换为 Redis/Ably 而**不改客户端契约** |
| D4 | 跨实例广播用 **Neon 作为总线**：`events` 出站表（outbox），每个事件流每秒轮询增量 | Serverless 无共享内存；MVP 以 ~1 qps/流 的读放大换取零额外基础设施；负载路径见 §7 |
| D5 | 封禁持久化 `bans` 表，**每次发消息/开流实时查库校验**（不依赖进程内缓存一致性） | 封禁即时生效、跨实例一致；唯一索引点查成本可忽略 |
| D6 | 管理员删消息 = **软删占位**（`deleted_at` 置位、清空内容、保留 id/时间） | 避免他人回复上下文悬空；保留审计 |
| D7 | 历史**滚动保留**：`HISTORY_RETENTION_DAYS`（默认 90 天）+ 出站表短期清理（1 小时） | Neon 免费额度有限；自清理无需外部定时器 |
| D8 | 管理端 = 内置极简 `/admin` 静态页面（零构建）+ JSON 管理 API | 开箱即用，同时允许他人自建管理前端 |
| D9 | 防滥用 = 每 IP 限流（按消息/登录/开流分桶）+ 长度上限 + 可选禁词，全走环境变量 | 覆盖最小可信基线，配置化便于复用者自定 |

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
                                    │   Neon Postgres               │
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

**发消息路径**：POST → 校验（封禁点查 → 限流 → 长度/禁词）→ INSERT messages → 写 `events` 出站行 → 返回 `201`。各事件流于下一次轮询收到并广播。

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
  type       TEXT NOT NULL,                 -- message | delete | ban
  payload    JSONB NOT NULL,                -- message: 完整行快照；delete: {message_id}；ban: {ip, reason}
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
| `GET /api/messages?before=<id>&limit=50` | 历史回溯，newest-first，默认最近 50（≤200）；软删消息返回占位 |
| `GET /api/messages?since=<id>&limit=200` | 增量补齐（gap-sync，oldest-first；与事件流事件去重由客户端按 id 处理） |
| `POST /api/messages` | body `{client_id, nick, text}` → `201 {id, created_at}`；`403 banned`（含 reason）／`429`／`400` |
| `GET /api/stream?since=<id\|0>` | SSE 事件流（`text/event-stream`） |

SSE 事件类型：

| event | data | 语义 |
|---|---|---|
| `message` | `{id, client_id, nick, text, created_at}` | 新消息（含自己发的，按 id 去重） |
| `delete` | `{message_id}` | 某消息被管理员删除 → 前端替换为占位 |
| `presence` | `{online: number}` | 在线人数（45s TTL 窗口） |
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
| `GET /api/admin/stats` | `{online, messages_total}` |

Cookie 安全：`HttpOnly; SameSite=Lax; Secure`（生产）；`ADMIN_SECRET` 启动时校验（生产缺失/过短即拒绝启动，错误码 `not_configured` 引导部署者）。

### 5.3 状态码速查

`200/201/204`、`400`（校验失败 code 细分）、`401`（口令错/会话失效）、`403 banned`、`404`、`409`（重复封禁）、`429`（限流 + `retry_after_ms`）、`500`、`503 not_configured`（缺 DATABASE_URL）。

## 6. 防滥用与安全（MVP 基线）

- **限流**（每 IP 分桶，落库 `ON CONFLICT` upsert）：消息 10 条/10s 且 300 条/h；登录 5 次/5min；开流 20 次/min。
- **长度/格式**：nick ≤ 24 字符；text ≤ 2000 字符；均 trim + 去控制字符；`client_id` 须为合法 UUID。
- **禁词**：`BANNED_WORDS`（逗号分隔，可选），命中 `400`。
- **IP 来源**：`x-forwarded-for` 首跳（Vercel 注入），本地开发回退请求 IP；入库前规范化。
- **CORS**：`CORS_ORIGINS` 逗号分隔白名单（默认 `*`，公开聊天端点）；管理端点仅同源（Cookie 机制天然同源约束）。
- **存储安全**：纯文本不存 HTML；XSS 为前端渲染责任（契约中明示）。
- **仓库**：无任何密钥；`.env.example` 为唯一模板。

## 7. 规模边界与演进路径（明确写死，避免"先上车后补票"的误判）

- **容量模型**：MVP 面向单房间、数百并发观看。每流每秒 1 次 `events` 增量读 + 每 5s 一次 presence COUNT。50 个在线观看者 ≈ 60 qps 读 + 少量写，Neon 免费档可承受；**超过后首先淘汰的是读放大**。
- **演进路径（不改客户端契约）**：事件流内部把"轮询 Neon"替换为 Redis Pub/Sub 推送（Upstash）或 Ably；`presence` COUNT 挪到 KV 计数器；必要时升级 WebSocket 服务器（如 Bun 自建）。客户端看到的仍是同一组事件。
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
  lib/db.ts schema.ts migrate.ts
  lib/security.ts     # 口令、签名 Cookie、IP 解析
  lib/limits.ts       # 限流桶、校验、禁词
  lib/stream.ts       # 事件流循环（可替换总线）
public/admin.html     # 管理页（零构建）
drizzle/              # SQL 迁移
.env.example  vercel.json  docs/api.md(实现期由本规格提取)
tests/                # bun test（单元为主）
```

## 10. 待实现期确认的技术细节（非契约）

- Vercel `maxDuration` 需按当前套餐在 `vercel.json` 配置并实测 SSE 断开时机。
- Neon HTTP 驱动在 Bun 本地的兼容性（备选：Bun 本地跑 `postgres.js` + 同一 repository 接口）。
- 清洗任务的触发点（插入计数达到阈值时顺手清理，不引入外部 cron）。
