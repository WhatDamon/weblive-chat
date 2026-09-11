# WebLive Chat API 参考（v1）

本文档描述当前对外接口契约；改动请保持向后兼容并同步更新本文件。接入路线、客户端契约（重连/双游标/补齐）与排查见 [`integration.md`](./integration.md)。

- 时间：响应中的 `created_at` 一律 **ISO 8601 UTC**（SSE 事件载荷内为 **epoch 毫秒数字**，见下）。
- `id` / 游标：JSON 中一律**字符串**（数据库为整数自增）。
- 错误统一信封：`{"error": {"code": string, "message": string, "retry_after_ms"?: number, "reason"?: string}}`。
- 需 JSON body 的接口要求 `Content-Type: application/json`。
- 在线人数按 `client_id` 去重（同一浏览器多标签计 1 人）；封禁为**禁言不禁看**：被封 IP 无法发言，但可继续观看。

## 1. 公开端点（免登录）

| 端点 | 说明 |
|---|---|
| `GET /api/meta` | 轻量配置（**无 DB 依赖**）：`{limits:{nick_max, text_max, retention_days}, presence:{ttl_s}, client_ip}` |
| `GET /api/messages?before=<id>&limit=<n>` | 历史回溯，**newest-first**；`limit` 缺省 50（合法 1–200 夹取，非纯数字 → `400 invalid_cursor`）；软删消息以占位返回；回溯深度受 `HISTORY_MAX_BACKFILL` 限制 |
| `GET /api/messages?since=<id>&limit=<n>` | 增量补齐（gap-sync），**oldest-first**；与 SSE 事件按 `id` 去重由客户端负责 |
| `POST /api/messages` | body `{client_id, nick, text}` → `201 {id, created_at}` |
| `GET /api/stream?since=<id\|0>&client_id=<uuid>` | SSE 事件流（`text/event-stream`） |

规则与细节：

- `before` 与 `since` **互斥**（同时给出 → `400 invalid_body`）。
- `limit`：纯数字才合法（`0` 夹到 `1`）；浮点/负数/非数字 → `400 invalid_cursor`。最大值 200。
- `ephemeral` 模式（历史超限自动降级）下，`GET /api/messages` 恒返回 `{messages: [], mode: "ephemeral"}`。
- 普通模式响应：`{messages: MessageView[], mode: "full"|"degraded_retention"}`，其中
  `MessageView = {id: string, client_id: string, nick: string, text: string|null, deleted: boolean, created_at: ISO8601}`
  （软删消息：`deleted: true` 且 `text: null`，占位行保留）。
- `POST /api/messages` 校验顺序：**格式/禁词（不耗限流预算、不触发 DB）→ 封禁（`403 banned`，含 `reason`）→ 限流（`429 rate_limited`）→ 写入**。
  - 400 子码：`invalid_body`（非 JSON）、`invalid_uuid`、`nick_empty`、`nick_too_long`、`text_empty`、`text_too_long`、`banned_word`（昵称与内容都会检查；响应不指出具体字段，也不回显命中的词）。
  - 201 响应 `id` 为字符串消息 id；`ephemeral` 模式仅广播不落历史，`id` 形如 `"e<eventId>"`（标识直播消息，不可回溯）。
  - 存储故障 → `503 db_unavailable`。
- `GET /api/stream` 参数：
  - `since`：可选，须为纯数字，否则按 `0`（从头增量）。
  - `client_id`：可选，须为合法 UUID；用于 presence 归因与多标签去重；缺省 = 每连接按独立 `anon-<uuid>` 计入心跳。
  - 开流前按 IP 限流（`stream` 桶，`STREAM_RATE_PER_MIN`），超限 `429 rate_limited`。
  - **封禁不拦流**（禁言不禁看）：被禁 IP 的流保持打开，仅首帧收到 `ban` 提示。

### SSE 事件类型

信封：`event: <type>` + `data: <JSON>`（多行 data 以 `\n` 分隔拼接，标准 SSE）。消息载荷内 `created_at` 为 **epoch 毫秒数字**。

| event | data | 语义 |
|---|---|---|
| `message` | `{id, client_id, nick, text, created_at}` | 新消息（含自己发的；`ephemeral` 下 `id` 为 `"e<eventId>"`；按 `id` 去重） |
| `delete` | `{id: string}` | 管理员软删某消息 → 前端替换为占位（与 MessageView.id 同字段） |
| `presence` | `{online: number}` | 在线人数（45s TTL 窗口，按 `client_id` 去重） |
| `notice` | `{kind: "history_mode", mode, retention_days}` | 持久化模式变化（如自动降级到 `ephemeral`） |
| `ban` | `{reason}` | 本连接 IP 被**禁言**（仅推给命中 IP 的流；流保持、可继续旁观） |
| `error` | `{code, message}` | 流内 DB 故障等异常：**推送停止但 SSE 连接不主动关闭**（保持至平台超时/客户端断开）——客户端收到即视为流失效并携带 `since` 重连 |
| `: ping`（注释行，非事件） | — | 空闲约 15s 保活；客户端忽略 |

### 流与游标语义

- `/api/stream` 的 `since` 指向 **`events.id`**（出站表保留 ~1h）；`/api/messages?since=` 指向 **`messages.id`**——**两个独立 id 空间**。
- 客户端流程：开流（`since=0` 或上次游标）→ 历史/gap-sync 走 `/api/messages?since=` → 事件按消息 `id` 去重。
- **回退规则**（服务端自动）：若 `since` 落后于 events 保留期（旧游标空转），把游标重置为当前最大 `events.id` 并从该处继续；**缺口用 `/api/messages?since=<本地最新 messages.id>` 补齐**。
- 断线重连由客户端负责：Vercel 函数单次最长 300s，到点断流是预期行为，携带 `since` 重连即可。

## 2. 管理端点（需会话 Cookie `wl_admin`）

会话：`POST /api/admin/login` 以 `ADMIN_SECRET` 换 **HMAC 签名 HttpOnly Cookie**（`HttpOnly; SameSite=Lax; Path=/`，生产加 `Secure`；有效 `ADMIN_SESSION_DAYS` 天）。未认证/过期统一 `401 unauthorized`。

| 端点 | 说明 |
|---|---|
| `POST /api/admin/login` | body `{secret}` → `200 {ok:true}` + `Set-Cookie`；`400 invalid_body` / `401 invalid_secret` / `429 rate_limited`（登录桶）/ `503` |
| `GET /api/admin/me` | Cookie 有效 → `200 {authed:true}`；否则 `401 unauthorized` |
| `POST /api/admin/logout` | 清除 Cookie → `200 {ok:true}` |
| `GET /api/admin/bans?limit&offset` | 封禁列表（`created_at` 倒序）：`200 {bans:[{ip, reason, created_at}]}`（`created_at` 为 epoch 毫秒数字；limit 缺省 200、1–500 夹取；offset 缺省 0） |
| `POST /api/admin/bans` | body `{ip, reason?}` → `200 {created: boolean, ip}`；**幂等 upsert**：重复封禁覆盖 reason 并回 `created:false`（无 409）；ip 不合法 → `400 invalid_body` |
| `DELETE /api/admin/bans/:ip` | 解封 → `204`；不存在 → `404 not_found` |
| `DELETE /api/admin/messages/:id` | **软删**（占位保留、内容清空、`deleted_by='admin'`，不存操作者 IP）并广播 `delete` 事件 → `204`；不存在 → `404 not_found` |
| `GET /api/admin/stats` | `{online, messages_total, messages_retained, history:{mode, retention_days, estimate_bytes}}` —— `messages_total`/`messages_retained` 同为**物理行数**（含软删占位）；`estimate_bytes = retained × 400`；读取触发一次维护评估（刷新档位/清理） |

> 管理端不提供消息列表查询——消息查看走公开 `GET /api/messages`（软删占位同样透出），避免重复契约面。
> 管理端点与公开端点共用 `/api/*` 的 Origin 白名单中间件；Cookie 的 SameSite=Lax 使管理接口仅同源可用（跨源自建管理前端需显式列入 `ALLOWED_ORIGINS` 并自行处理 credentials）。

## 3. Origin 白名单

| 配置 | 行为 |
|---|---|
| `ALLOWED_ORIGINS` 未设置 | 开放模式：公开端点 `Access-Control-Allow-Origin: *` |
| 设置名单（逗号分隔精确 Origin） | 白名单模式（fail-closed）：名单内请求回显该 Origin + `Vary: Origin`；名单外 → `403 origin_not_allowed` |
| 请求不带 Origin | 默认放行（同源/curl）；`REQUIRE_ORIGIN=1` 时拒绝 → `403 missing_origin` |

- 匹配：精确 `scheme://host[:port]`，忽略路径/query、去尾斜杠、主机小写；**不支持通配**。
- ⚠️ **白名单会锁住同源内置页**：浏览器写请求（POST/DELETE）必带当前页 Origin，设置名单时**必须把部署自身域名一并列入**，否则同源 `/demo.html` 发言与 `/admin` 封禁/删除均被 `403 origin_not_allowed` 拒（GET 历史/SSE 流不受影响）。
- `OPTIONS` 预检：仅对放行 Origin 回 `204`，带 `Access-Control-Allow-Methods: GET,POST,DELETE,OPTIONS`、`Access-Control-Allow-Headers: content-type`、`Access-Control-Max-Age: 86400`。
- 白名单是**来源限制而非认证**：拦不住不带 Origin 的脚本/curl（除非 `REQUIRE_ORIGIN=1`）；强制手段靠封禁 + 限流。

## 4. 错误码速查

| HTTP | code | 场景 |
|---|---|---|
| 400 | `invalid_body` | 请求体缺失/非 JSON；`before` 与 `since` 同时使用；管理 body 字段非法 |
| 400 | `invalid_uuid` | `client_id` 不是合法 UUID |
| 400 | `invalid_cursor` | `GET /api/messages` 的 `limit` 与 `DELETE /api/admin/messages/:id` 的 `:id` 非纯数字（游标 id 必须是正整数）；**`before`/`since`/SSE `since` 的非法值不报错**——按缺省处理（历史取最近 50 条、流从 0 续传） |
| 400 | `nick_empty` / `nick_too_long` / `text_empty` / `text_too_long` | 长度/空值校验 |
| 400 | `banned_word` | 昵称或内容命中违禁词（归一化子串匹配：忽略全角/空白/标点/零宽字符；不回显命中词） |
| 401 | `invalid_secret` / `unauthorized` | 口令错 / 会话缺失·过期·被篡改 |
| 403 | `banned` | 该 IP 被禁言（附 `reason`） |
| 403 | `origin_not_allowed` / `missing_origin` | Origin 不在名单 / `REQUIRE_ORIGIN` 下缺 Origin |
| 404 | `not_found` | 解封不存在 / 删不存在的消息 |
| 429 | `rate_limited` | 超限（附 `retry_after_ms`） |
| 503 | `db_unavailable` | 存储不可用/冻结（含 Neon 冻结语义） |
| 500 | — | 未预期服务端错误 |

## 5. curl 示例

发消息：

```bash
curl -i -X POST http://localhost:3000/api/messages \
  -H 'content-type: application/json' \
  -H 'x-forwarded-for: 203.0.113.7' \
  -d '{"client_id":"11111111-2222-4333-8444-555555555555","nick":"路人甲","text":"大家好"}'
# → 201 {"id":"1","created_at":"2026-09-09T…Z"}
```

拉历史（newest-first）：

```bash
curl -s 'http://localhost:3000/api/messages?limit=5' -H 'x-forwarded-for: 203.0.113.7'
# → {"messages":[{...}],"mode":"full"}
```

订阅事件流（SSE，持续连接）：

```bash
curl -N 'http://localhost:3000/api/stream?client_id=11111111-2222-4333-8444-555555555555' \
  -H 'x-forwarded-for: 203.0.113.7'
# event: presence  data: {"online":1}
# event: message   data: {"id":"1","client_id":"…","nick":"路人甲","text":"大家好","created_at":…}
```

> 本地 curl 可不带 `x-forwarded-for`（回退 `DEV_IP`）；若设了 `ALLOWED_ORIGINS` 白名单，curl（无 Origin）仍默认放行，除非 `REQUIRE_ORIGIN=1`。

管理示例（登录 → 封禁；cookie 存本地文件）：

```bash
curl -i -c cookies.txt -X POST http://localhost:3000/api/admin/login \
  -H 'content-type: application/json' \
  -d '{"secret":"你的ADMIN_SECRET"}'

curl -i -b cookies.txt -X POST http://localhost:3000/api/admin/bans \
  -H 'content-type: application/json' \
  -d '{"ip":"203.0.113.7","reason":"spam"}'
# → 200 {"created":true,"ip":"203.0.113.7"}
```
