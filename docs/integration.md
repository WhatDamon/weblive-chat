# WebLive Chat 接入指南

面向要把聊天接进自己前端 / App / 小程序的开发者。读完这一篇即可完成接入，不需要看服务端代码。

配套文档：

| 文档 | 用途 |
|---|---|
| 本文 | 接入路线、客户端契约、必须处理的坑 |
| [`api.md`](./api.md) | 接口速查（字段、错误码） |
| `public/demo.html` | 内置参考客户端（同源部署，可直接打开对照） |
| [`examples/client.mjs`](../examples/client.mjs) | 可运行的最小客户端（零依赖，本文示例的完整版） |
| [`design.md`](./design.md) | 服务端设计取舍与部署细节 |

---

## 1. 一分钟了解

```text
浏览器/客户端                     服务端（无状态函数）              存储
     │                                   │                        │
     │  POST /api/messages  ────────────▶ │  写 messages + events ▶ │
     │                                   │                        │
     │  GET  /api/stream (SSE) ◀──────────│ ◀── 轮询 events 增量 ───│
     │      message/delete/presence/...   │                        │
     │  GET  /api/messages  ────────────▶ │ ◀── 读历史/回溯 ───────│
```

| 事实 | 说明 |
|---|---|
| **免登录** | 身份 = 客户端自己生成的一个 UUID（`client_id`）。没有注册、没有密码、没有 token 续期 |
| **上行** | `POST /api/messages`（普通 JSON 请求） |
| **下行** | `GET /api/stream`（SSE，服务端单向推送） |
| **在线人数** | 服务端按 `client_id` 去重后广播 `presence` 事件；同一浏览器多标签算 1 人 |
| **禁言不禁看** | 被禁 IP 只能看不能发（POST 返回 403），已开的流不会被打断 |
| **无历史模式** | 存储超限时服务端自动降级为「仅实时」：SSE 照常，但历史接口返回空 |
| **无 WebSocket** | 有意选择 SSE + POST：连接会被平台按时限切断，客户端**必须**自动重连（见 §3.3） |

---

## 2. 五分钟跑通

```bash
# 指向你的部署（或本地 bun dev 的 http://localhost:3000）
bun examples/client.mjs https://your-app.vercel.app 我的昵称
```

输出形如：

```text
connected https://your-app.vercel.app
client_id=3f2b…（首次运行生成并在本地缓存）
[online] 3
[8:10:24 PM] 甲: 你好
[8:10:27 PM] 我的昵称: hello from the example client 8:10:27 PM
```

`examples/client.mjs` 已经包含本文所有要点（身份持久化、SSE 解析、断线重连、补历史、去重、看门狗），
可以直接当作实现参考，也可以只读下面的最小骨架自己写。该文件由 `bun tests/e2e/smoke.ts` 每次实跑，不会随服务端变化而失效。

### 最小可用骨架（浏览器）

```js
// WebLive Chat 最小接入骨架：建流 → 收事件 → 发言，含自动重连与去重
const BASE = "https://your-app.vercel.app";

// 身份：一个 UUID，存 localStorage（同一浏览器多标签共享 → 在线人数按人计）
let clientId = localStorage.getItem("wl.client_id");
if (!clientId) {
  clientId = crypto.randomUUID();
  localStorage.setItem("wl.client_id", clientId);
}

let since = 0; // 流游标 = events.id
let lastMessageId = 0; // 历史游标 = messages.id
const seen = new Set(); // 去重（重连会重放游标之后的事件）

// 事件回调：按需替换成你的渲染逻辑
const onEvent = {
  message: (m) => console.log(m.nick, m.text),
  delete: (d) => console.log("已删除", d.id),
  presence: (p) => console.log("在线", p.online),
  notice: (n) => console.log("历史模式", n.mode),
  ban: (b) => console.log("本机被禁言", b.reason),
  error: (e) => console.warn("流错误", e),
};

function dispatch(type, data) {
  if (type === "message") {
    const id = String(data.id);
    if (seen.has(id)) return; // 幂等：续传/补历史都会重复投递
    seen.add(id);
    if (/^\d+$/.test(id)) lastMessageId = Math.max(lastMessageId, Number(id));
  }
  onEvent[type]?.(data); // 未知事件类型直接忽略（前向兼容）
}

async function connect() {
  const qs = new URLSearchParams({ since: String(since), client_id: clientId });
  const res = await fetch(`${BASE}/api/stream?${qs}`, {
    headers: { accept: "text/event-stream" },
  });
  if (!res.ok) throw new Error(`stream HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break; // 连接被平台/网络切断 —— 正常现象
    buf += decoder.decode(value, { stream: true });
    let i = buf.indexOf("\n\n");
    while (i >= 0) {
      let type = "message";
      const data = [];
      for (const line of buf.slice(0, i).split("\n")) {
        if (line.startsWith(":")) continue; // ": ping" 心跳，忽略
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      buf = buf.slice(i + 2);
      i = buf.indexOf("\n\n");
      if (data.length === 0) continue;
      try {
        dispatch(type, JSON.parse(data.join("\n")));
      } catch {
        /* 非 JSON 帧忽略 */
      }
    }
  }
}

/** 重连前先补历史：events 出站表只保留 1 小时，断线久了只靠流会丢消息 */
async function backfill() {
  const qs = new URLSearchParams({ since: String(lastMessageId), limit: "200" });
  const res = await fetch(`${BASE}/api/messages?${qs}`);
  if (!res.ok) return;
  for (const m of (await res.json()).messages) dispatch("message", m);
}

async function loop() {
  for (;;) {
    try {
      await backfill();
      await connect();
    } catch (err) {
      onEvent.error(err);
    }
    await new Promise((r) => setTimeout(r, 1000)); // 退避 1s 再连
  }
}
loop();

/** 发言 */
async function send(text, nick = "路人") {
  const res = await fetch(`${BASE}/api/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, nick, text }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(body?.error?.message ?? res.status), body?.error);
  return body; // { id, created_at }
}
```

---

## 3. 三个必须先理解的概念

### 3.1 `client_id` 就是你的身份

- **生成**：`crypto.randomUUID()`，客户端生成，服务端不签发。
- **持久化**：浏览器存 `localStorage`（同一浏览器多标签共享 → 在线人数按人计）；App 存本地偏好；小程序存 `wx.setStorageSync`。
- **约束**：必须是合法 UUID（`8-4-4-4-12` 十六进制），否则 `400 invalid_uuid`。
- **性质**：它是**匿名标识，不是账号**。服务端不校验归属，任何人都可以冒用别人的 `client_id`。因此它只用于在线计数与消息署名，不要拿它做权限判断。
- **本地开发**：不带 `client_id` 也能开流，服务端会给每条连接分配一次性的 `anon-<uuid>`——但那样每个标签页都算一个独立的人，人数会偏高。

### 3.2 两个游标，别混用（最容易踩的坑）

| 接口 | 参数 | 游标语义 |
|---|---|---|
| `GET /api/stream` | `since` | **`events.id`**：实时广播表的自增 id |
| `GET /api/messages` | `since` | **`messages.id`**：聊天历史的自增 id |
| `GET /api/messages` | `before` | **`messages.id`**：向上翻历史（取 `id < before` 的最近 N 条） |

两个 id 来自**不同的自增序列**，值不能互换。实践中的正确用法：

- 实时流只负责「快」：`since` 交给服务端推进，客户端不关心它是多少（也确实拿不到 `events.id`）。
- 历史只负责「全」：用消息自身的 `id`（`messages.id`）做补洞与翻页。
- 断线重连时，**用最后一条消息的 id 去补历史**，而不是试图续 `events` 游标——`events` 表只保留 1 小时（见 §5），过期后旧游标无意义。
- 形如 `e12` 的 id 是「仅实时」降级模式下的直播消息（见 §4.5），**不可回溯**，不要拿它推历史游标。

### 3.3 连接一定会断，这是设计的一部分

服务端跑在 Serverless 函数上（Vercel），**每个 SSE 连接的生命周期受函数最大执行时长约束**——本项目 `vercel.json` 配为 300s，到点连接即结束（各档位上限见 [官方文档](https://vercel.com/docs/functions/configuring-functions/duration)，2026-09-12 核对）；此外中间代理、移动网络切换也会断。

因此客户端契约是：

1. **必须自动重连**，间隔建议 ≥ 1s（开流本身有 20 次/min 的限流）。
2. **必须带 `since` 续传**，否则重连后从头回放，会出现大量重复。
3. **必须幂等去重**（按消息 id），因为续传本质上就是「重放游标之后的事件」。
4. **建议加静默断链看门狗**：服务端空闲时每 15s 发一行 `: ping` 注释保活，若 45s 收不到任何帧就主动断开重连（`examples/client.mjs` 里有实现）。

---

## 4. 接口详解

所有接口前缀 `/api`，响应均为 JSON（SSE 除外）。错误统一信封：

```json
{ "error": { "code": "rate_limited", "message": "请求过于频繁", "retry_after_ms": 42000 } }
```

### 4.1 `GET /api/meta` — 读运行参数

```json
{
  "limits": { "nick_max": 24, "text_max": 1000, "retention_days": 90 },
  "presence": { "ttl_s": 45 },
  "client_ip": "203.0.113.7"
}
```

- **不要在前端硬编码长度限制**，启动时读一次（运营可能改环境变量并重新部署）。
- `client_ip` 是服务端看到的你的 IP（受代理影响）——可用于「本机被禁言」提示，或做自测。

### 4.2 `GET /api/messages` — 历史、回溯、补洞

| 参数 | 说明 |
|---|---|
| `before` | 取 `id < before` 的最近若干条（向上翻历史）。非法值/0 按缺省处理 |
| `since` | 取 `id > since` 的若干条（补洞用，升序返回）。非法值按缺省处理 |
| `limit` | 默认 `50`，范围 `1..200`（越界夹取）；**非纯数字直接 `400 invalid_cursor`** |

`before` 与 `since` **互斥**，同时传 → `400 invalid_body`。

响应：

```json
{
  "messages": [
    { "id": "42", "client_id": "3f2b…", "nick": "甲", "text": "你好", "deleted": false, "created_at": "2026-09-11T11:44:38.443Z" }
  ],
  "mode": "full"
}
```

| 字段 | 说明 |
|---|---|
| `id` | 字符串（服务端是整数自增，序列化成字符串以免精度问题） |
| `text` | 已软删的消息为 `null`，同时 `deleted: true` → 前端渲染成「该消息已删除」占位 |
| `created_at` | **ISO 8601 字符串**（注意：SSE 里是数字毫秒时间戳，见 §4.4） |
| `mode` | `full`（全量）/ `degraded_retention`（已自动缩短保留期）/ `ephemeral`（**无历史**，此时 `messages` 恒为空数组） |

翻页示例（首屏 → 往上翻）：

```js
// 首屏：最近 50 条
const first = await (await fetch(`${BASE}/api/messages`)).json();

// 继续往上翻：以当前最早一条的 id 作为 before
const oldest = first.messages[0]?.id;
if (oldest) {
  const older = await (await fetch(`${BASE}/api/messages?before=${oldest}&limit=50`)).json();
  // older.messages 也是「新 → 旧」排列，prepend 到列表头部
}
```

> 回溯深度可能被运营限制（`HISTORY_MAX_BACKFILL`）：超出深度的更早历史会被服务端过滤掉，表现为翻到某一页后不再返回更早内容。这是预期行为，不是分页 bug。

### 4.3 `POST /api/messages` — 发言

```json
{ "client_id": "3f2b…", "nick": "甲", "text": "你好" }
```

成功：`201` → `{ "id": "43", "created_at": "2026-09-11T11:44:38.443Z" }`

**校验顺序（服务端契约，前端可依赖）**：

1. 请求体格式 → 长度 → 违禁词：命中即 `400`，**不消耗限流预算、不查数据库**
2. 封禁检查：命中 `bans` 表 → `403 banned`（带 `reason`）
3. 限流：超出 → `429 rate_limited`（带 `retry_after_ms`）
4. 写库 → 广播

细节：

- `nick` 与 `text` 都会被 `trim` 并剥离控制字符；长度按**字符数**（`nick ≤ 24`、`text ≤ 1000`，以 `/api/meta` 为准）。
- **昵称也会过违禁词**（返回 `400 banned_word`）。命中词不会回显，前端只提示「内容含违禁词」即可。
- 响应 `201` 不代表消息已显示：真正的消息体会经 SSE 广播回来（**包括你自己发的**）。推荐做法是等 SSE，而不是本地回显——这样顺序与去重都由服务端统一定序。若一定要本地回显，请按 id 去重。
- 降级模式下 `id` 形如 `"e12"`（见 §4.5）。

### 4.4 `GET /api/stream` — 实时下行（SSE）

| 参数 | 说明 |
|---|---|
| `since` | 可选，纯数字；非法值按 `0`（从头增量）处理。语义是 `events.id` |
| `client_id` | 可选，合法 UUID；用于在线人数去重。缺省按 `this connection` 计一个匿名身份 |

响应头为 `text/event-stream`。事件表：

| `event:` | `data:` 结构 | 何时出现 |
|---|---|---|
| `message` | `{ id, client_id, nick, text, created_at }` | 有人发言（含自己）。`created_at` 是**数字毫秒** |
| `delete` | `{ id }` | 管理员软删了某条消息（`id` 是 `messages.id`） |
| `presence` | `{ online }` | 在线人数**发生变化**时（不是定时广播） |
| `notice` | `{ kind: "history_mode", mode, retention_days }` | 服务端历史档位变化（如存储压力触发自动收缩） |
| `ban` | `{ reason }` | 开流时该 IP 已被禁言：只推一次提示，**流保持打开** |
| `error` | `{ code, message }` | 服务端内部错误（如存储不可用）：推送后停止推流，连接不主动关闭，请自行重连 |
| `: ping` | （注释行，无 data） | 空闲保活，每 ≥15s 一次。客户端忽略即可，但可用于看门狗计时 |

客户端必须遵守的三条：

1. **未知 `event:` 类型直接忽略**（服务端未来新增事件不得让旧客户端崩）。
2. **消息可能重复投递**（重连重放、补历史重叠），按 `id` 幂等。
3. **`created_at` 类型不一致**：SSE 里是数字，历史接口里是 ISO 字符串。统一处理：

```js
const toMs = (v) => (typeof v === "number" ? v : Date.parse(v));
const toISO = (v) => new Date(toMs(v)).toISOString();
```

### 4.5 降级模式（`ephemeral`）：只有实时，没有历史

当存储量逼近上限（行数或保留期压力）时，服务端会自动逐级缩短保留期（90→30→10→3→1 天），
到硬顶则切到 `ephemeral`：

- `GET /api/messages` 恒返回 `{ messages: [], mode: "ephemeral" }`
- 发言仍然可用：`POST` 返回 `{ "id": "e12" }`，消息经 SSE 广播给当时在线的所有人，**不落库、不可回溯**
- 档位变化会通过 `notice` 事件广播

前端建议：把 `mode` 与 `notice` 当状态展示（例如顶部提示「历史已暂时不可用，仅保留实时消息」），
并注意 `e…` 开头的 id 不能用于翻页/补洞。

### 4.6 错误码总表

| HTTP | `code` | 含义与处理 |
|---|---|---|
| 400 | `invalid_body` | 非 JSON / 字段类型错 / `before`+`since` 同时传 → 修请求 |
| 400 | `invalid_uuid` | `client_id` 不是 UUID → 重新生成并持久化 |
| 400 | `invalid_cursor` | `limit` 非纯数字（以及管理端 `:id`）→ 修参数 |
| 400 | `nick_empty` / `nick_too_long` / `text_empty` / `text_too_long` | 长度/空值 → 提示用户 |
| 400 | `banned_word` | 昵称或内容命中违禁词 → 提示「内容含违禁词」，**不要**把原因展示成具体词 |
| 403 | `banned` | 本机 IP 被禁言（含 `reason`）→ 切「只读」UI |
| 403 | `origin_not_allowed` / `missing_origin` | 跨域白名单未含当前页面 Origin → 见 §7 |
| 429 | `rate_limited` | 超限，按 `retry_after_ms` 退避后重试 |
| 503 | `db_unavailable` | 存储暂不可用（含冷启动建表失败）→ 稍后重试，UI 显示「连接异常」 |
| 401 | `unauthorized` / `invalid_secret` | 仅管理接口 |

---

## 5. 断线重连与补洞（完整策略）

**问题**：SSE 只能保证「你连着的这段时间」的消息。`events` 出站表只保留 **1 小时**
（远短于聊天历史），所以断线超过 1 小时后，旧的 `events` 游标已经无意义——服务端会发现游标
落后于已清理区间，于是把游标重置到当前最大 id 继续推，这期间产生的消息**不会**补给你。

**正确策略**（`examples/client.mjs` 已实现）：

```text
循环：
  1) 补历史：GET /api/messages?since=<最后一条消息 id>&limit=200   ← 用 messages.id，不是 events.id
  2) 建流：  GET /api/stream?since=<events 游标>&client_id=<uuid>
  3) 流结束（平台切断/网络抖动）→ 等 1s（或 429 的 retry_after_ms）→ 回到 1)
```

为什么「补历史」用 `since=<最后消息 id>` 就够：`messages.id` 单调递增，取回的是你漏掉的全部
持久化消息；重复的部分由客户端的 id 去重兜住。这样即使断开一整天也能补齐（除非消息
已被保留期清理——那是存储策略，不是接入问题）。

---

## 6. 限流、退避与预算

| 桶 | 默认 | 维度 | 超限响应 |
|---|---|---|---|
| 发消息 `msg` | 10 次/分钟 | 按 IP | `429 rate_limited` |
| 开流 `stream` | 20 次/分钟 | 按 IP | `429 rate_limited` |
| 管理登录 `login` | 5 次/分钟 | 按 IP | `429 rate_limited` |

固定 60s 窗口（按 epoch 对齐），可在部署侧用环境变量调整；实际值以 `/api/meta` 与运营配置为准。

客户端建议：

- **本地节流**：连点发送按钮前先判断，别把 429 当成正常交互（例如发送中禁用按钮 300ms）。
- **退避**：拿到 `retry_after_ms` 就按它等，不要固定 1s 死连——会被继续限流。
- **重连退避**：连续失败时用指数退避（1s → 2s → 4s，上限 30s），成功后复位。
- **人数即成本**：自托管时注意在线人数 = 并发 SSE 连接。服务端已把 presence 写入按连接节流到
  10s/次、人数统计 5s/次，仍建议控制无意义的常驻连接（例如页面不可见时保留但不再渲染）。

---

## 7. 跨域接入（前后端分离部署）

服务端对 `/api/*` 有统一的 Origin 闸口：

| 部署配置 | 行为 |
|---|---|
| 未设 `ALLOWED_ORIGINS`（默认） | 开放：响应 `access-control-allow-origin: *`，任何站点可调用 |
| 设了 `ALLOWED_ORIGINS` | 白名单 fail-closed：命中则回显该 Origin 并加 `Vary: Origin`；未命中 → `403 origin_not_allowed`（响应体附 `origin` 与 `allowed_origins_count`）；支持 `*.damon233.top` **通配整域**（含主域与全部子域，可写 `https://*.x.com` 限定协议、`*.x.com:8443` 限定端口）；写 `*` 等价于留空（全开） |
| `REQUIRE_ORIGIN=1` | 连无 Origin 的直连（curl / 服务端对服务端）也拒绝 → `403 missing_origin` |

预检：`OPTIONS /api/*` 返回 `204`，允许 `GET,POST,DELETE,OPTIONS`，允许头 `content-type`，`Max-Age: 86400`。

接入要点：

- **白名单必须包含你自己的页面域名**（含内置 `/demo.html`、`/admin` 所在域名），否则同源页面自己
  也会被 403 挡掉——这是最常见的「接完就打不开」原因。若你会经常换子域（或本地 + 线上多域名），直接用通配：`ALLOWED_ORIGINS=*.damon233.top,http://localhost:3000`，比逐个列举省事且不会再漏。
- **通配符写错会让配置加载失败**（如 `https://*`、`*.`、`https://a.*.b.com`、端口非数字）：本地进程直接退出；Vercel 上请求报错且日志指明条目。宁可直接失败也不静默失效；精确条目忘了写 `https://` 则永远不会匹配（只记一条启动告警）。
- **Origin 白名单不是鉴权**：它只拦「第三方网页在浏览器里调用」，`curl` 或自建脚本可以随意伪造
  `Origin`。真正的访问控制是 IP 禁言 + 限流。
- **只信 `Origin`，不要依赖 `Referer`**（可被剥离/伪造）。
- **管理接口不要跨域调用**：`/api/admin/*` 用 HttpOnly + `SameSite=Lax` Cookie 鉴权，跨站
  fetch 不带 Cookie（且响应没有 `Allow-Credentials`）。自建后台请与 API **同源部署**，或干脆用内置 `/admin` 页面。
- **绝不要**把 `ADMIN_SECRET` 写进前端代码或从浏览器拼接管理请求。

---

## 8. 管理侧接入（运营后台）

内置 `/admin` 页面已覆盖全部运营动作；若你要做自己的后台，可直接调用同一组 JSON 接口。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/admin/login` | 体 `{ secret }`；成功 `200 { ok: true }` 并 `Set-Cookie: wl_admin=…`（HttpOnly/SameSite=Lax/Path=/，生产带 Secure，有效期 `ADMIN_SESSION_DAYS` 默认 7 天） |
| `GET` | `/api/admin/me` | `{ authed: true }`（探测会话是否有效） |
| `POST` | `/api/admin/logout` | 清 Cookie |
| `GET` | `/api/admin/bans?limit=&offset=` | `{ bans: [{ ip, reason, created_at }] }`（`created_at` 为毫秒数字；`limit` 默认 200、上限 500） |
| `POST` | `/api/admin/bans` | 体 `{ ip, reason }` → `{ created, ip }`；**幂等**：重复封禁覆盖 `reason` 并返回 `created: false` |
| `DELETE` | `/api/admin/bans/:ip` | 解禁 → `204`；不存在 → `404 not_found` |
| `GET` | `/api/admin/stats` | `{ online, messages_total, messages_retained, history: { mode, retention_days, estimate_bytes } }` |
| `DELETE` | `/api/admin/messages/:id` | 软删消息 → `204`（会广播 `delete` 事件；`messages.id`） |
| `POST` | `/api/admin/purge/preview` | 危险操作·预检（只读）：体 `{scope}`（`chat`/`full`）→ `{scope, scope_desc, will_delete, keep, counts, confirm_phrase, token, expires_at}` |
| `POST` | `/api/admin/purge` | 危险操作·执行：体 `{scope, token, confirm, secret}` → `{scope, deleted}`（各表实际删除行数） |

注意：

- 登录失败一律 `401 invalid_secret`（**不区分**「口令错」与「无此账号」）；错误口令也计入登录限流。
- **清空数据是两阶段 + 多重校验的危险操作**：先 `preview`（只读，下发 60 秒一次性令牌与逐字确认短语），再 `purge` 提交「令牌 + 短语 + 重输的 `ADMIN_SECRET`」。令牌绑定档位与发起 IP、只能使用一次；`chat` 档只清消息与事件（**封禁名单会保留**），`full` 档清五张表。预检与执行共用一个限流桶（默认 5 次/分钟）。
- 清空**不影响已连接的 SSE 流**：在线客户端仍显示旧消息，需自行刷新页面才能看到一致视图。
- 软删是**占位删除**：消息行仍在（`text: null`, `deleted: true`），历史接口与 SSE 都会告知；
  客户端的实时列表要处理「消息先到达、后被删除」的乱序情况（按 id 就地替换成占位）。
- `stats` 读取会顺带触发一次保留期评估，所以它的 `mode` 是**最新档位**。

同源自建后台示例：

```js
await fetch("/api/admin/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ secret }), // 由使用者输入，不要硬编码
  credentials: "same-origin", // 同源才会带上 wl_admin Cookie
});
const { bans } = await (await fetch("/api/admin/bans?limit=100", { credentials: "same-origin" })).json();
```

---

## 9. 部署形态对客户端的影响

| 形态 | 对客户端的影响 |
|---|---|
| **Vercel（推荐）** | 每请求可能命中不同函数实例，但实例间通过数据库广播，客户端无感；SSE 连接最长存活到函数时限（本项目 `maxDuration: 300s`）→ **自动重连是硬要求**；冷启动首个请求可能慢一两百毫秒 |
| **自托管（`bun start` / Node）** | 单进程长驻，连接可以一直不断；`DB_PROVIDER=memory` 时无持久化（仅本地演示，多实例不共享） |
| **任意 CDN / 反代** | 若代理有 60s 空闲超时，`": ping"`（15s）足以保活；请确保**不缓冲** `text/event-stream`（关闭响应缓冲 / `X-Accel-Buffering: no`） |

> **时效**：本节与 §9.1 涉及的平台行为与数字（函数时长上限、实例计费语义、档位额度）核对于 **2026-09-12**，来源 Vercel 官方 [Limits](https://vercel.com/docs/limits) / [Fluid Compute](https://vercel.com/docs/fluid-compute)；平台调整后以官方为准。

### 9.1 省服务端额度：不可见就断开（强烈建议）

Vercel Hobby 档函数固定 **2 GB 内存且不可下调**，免费额度是 **360 GB-hr 内存时长/月**，按**实例存活且有在途请求**计（计到最后一个在途请求结束，空闲冻结不计费）——所以**一条 SSE 常连 = 实例持续计费**。折算下来只有 **180 实例小时/月**，而一个 7×24 常显标签页是 720 小时/月，**是该额度的 4 倍**。先撞墙的是内存而不是 CPU（完整账目见 `docs/design.md` §7.4），所以最划算的两步都在浏览器端：

1. **不可见就不连**（后台标签页）
2. **可见但没人动也不连**（忘记关的标签页：无鼠标/键盘/滚动 5 分钟后转低频轮询）

内置 `/demo.html` 已经这么做，接入方建议照搬：

```js
let ctrl = null, idle = false, lastActive = Date.now();
let paused = document.visibilityState === "hidden"; // 以隐藏状态打开就不建流
const IDLE_MS = 300_000, POLL_MS = 30_000;

document.addEventListener("visibilitychange", () => {
  paused = document.visibilityState === "hidden";
  lastActive = Date.now();
  if (paused) ctrl?.abort();                      // 释放连接 = 释放实例
  else backfill();                                // 回来先把缺口补上，再重连
});
for (const ev of ["mousemove", "mousedown", "keydown", "wheel", "scroll", "touchstart"]) {
  document.addEventListener(ev, () => { lastActive = Date.now(); idle = false; }, { passive: true });
}
setInterval(() => {                               // 可见但长时间无操作 → 降级
  if (paused || idle || Date.now() - lastActive < IDLE_MS) return;
  idle = true;
  ctrl?.abort();                                  // 停止常连计费
}, 1000);

async function connect() {
  let wasIdle = false;
  while (true) {
    if (paused) { await sleep(1000); continue; }
    if (idle) { wasIdle = true; await sleep(POLL_MS); if (!paused && idle) await backfill(); continue; }
    if (wasIdle) { wasIdle = false; await backfill(); }  // 轮询期间的空缺，重连前补上
    ctrl = new AbortController();
    const res = await fetch(`/api/stream?since=${since}&client_id=${cid}`, { signal: ctrl.signal });
    // ...读事件循环...
  }
}
```

要点与代价：

- **降级期间没有 presence 心跳**：静默 45s（TTL）后会从在线人数里消失，一操作就立刻回到在线——这是「离开」的合理语义，不是 bug。
- **降级期间没有 `delete` / `notice` 实时事件**，全靠回到常连前的那次 `backfill()` 补齐（所以它必须先跑，再重连）。
- 阈值可覆盖：页面若存在 `window.WL = { idleMs, pollMs }` 则用它（内置页默认 5 分钟 / 30s）。
- 补缺口时注意：历史接口会把「已删除」的消息以 `deleted:true, text:null` 返回，凡已渲染过的条目要就地替换成删除占位（内置页的 `loadHistory(true)` 就是这么做的）。

> 更完整的「前端怎么做才省」清单（含 SPA 释放、重连退避、多标签共享、自检清单）见 **`docs/quota.md`**。

还有两档更省的做法：

- **纯轮询（推荐给“几十人同时在线”的规模）**：完全不建流，每 30s 拉一次 `/api/messages?since=<本地最新 messages.id>`（成本约 0.03–0.1 GB-hr/小时，常连是 2 GB-hr/小时，省 20–60 倍）。代价是没有 presence/`delete`/`notice` 实时事件，需自行轮询补齐。
- **别把示例客户端常驻**：`examples/client.mjs` 是终端进程、没有“可见性”概念，挂着就是 2 GB-hr/小时。

---

## 10. 快速排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 收到重复消息 | 重连带 `since` 会重放游标之后的事件 | 按消息 `id` 去重（`e…` 开头的是直播消息，见 §4.5） |
| 断线一段时间后消息丢了 | 只用了 SSE，没有补历史；`events` 表 1h 后清理 | 重连前先 `GET /api/messages?since=<最后消息 id>` |
| 在线人数偏高/偏低 | 没带 `client_id`（每连接算一人）；或 `client_id` 没持久化 | 用 localStorage 持久化并随流带上（另注意 45s 无心跳即掉线） |
| 人数久久不变 | presence 只在**人数变化**时广播，且每 5s 统计一次 | 属正常，最长约 5s 才反映变化 |
| 一直 `403 origin_not_allowed` | `ALLOWED_ORIGINS` 未含当前页面域名（**换域名后忘了同步是最常见原因**） | 用 403 响应体里的 `error.origin` 确认被拒来源，把它加进白名单（含 `https://`，不要带路径/末尾斜杠）；改完**需重新部署**才生效 |
| 直连脚本 `403 missing_origin` | 部署开了 `REQUIRE_ORIGIN=1` | 脚本显式带 `Origin` 头，或把 `REQUIRE_ORIGIN` 置 `0` / 删除该变量 |
| 不确定闸口是否锁住 | — | `curl /api/meta` 看 `origin_mode`：`open` = 未配白名单，`locked` = 已配 |
| `400 banned_word` | 昵称或内容命中违禁词（含插空/全角变体） | 提示「内容含违禁词」；词库白名单见 `data/banned/README.md` |
| `429` | 触发限流（按 IP） | 按 `retry_after_ms` 退避，前端加本地节流 |
| 历史接口返回空但能聊天 | 存储超限自动降级（`mode: "ephemeral"`） | 正常降级行为，UI 提示「历史暂不可用」；运营侧看 `/api/admin/stats` |
| 所有接口 `503 db_unavailable` | 数据库不可达 / `DATABASE_URL` 配错 / Turso token 过期 | 检查部署环境变量；这是**快速失败**，不是挂起 |
| 流一直收不到自己的消息 | 前端自己把 POST 当成已发送并吞掉了事件 | 不要本地跳过，统一由 SSE 渲染 |

---

## 11. 版本与兼容性

- 当前对外契约版本 **v1**（见 `docs/api.md`）。
- **向后兼容承诺**：新增响应字段、新增 SSE 事件类型、新增错误码可以随时发生——客户端必须
  「忽略未知字段 / 忽略未知事件 / 只对已知 `code` 分支处理」。
- **破坏性变更**（删字段、改事件结构、改 id 语义）会升到 v2 并提供并行期。
- 已知的一致性瑕疵（v1 内不改，等 v2 统一）：SSE 的 `created_at` 是毫秒数字，历史接口是 ISO 字符串；
  客户端按 §4.4 的 `toMs()` 归一化即可。

---

## 12. 术语

| 术语 | 含义 |
|---|---|
| `client_id` | 客户端自持的匿名 UUID，用于署名与在线去重 |
| `events` 表 | 服务端出站广播表（保留 1h），SSE 的增量来源 |
| `messages` 表 | 聊天历史（受保留期约束），历史接口的来源 |
| `presence` | 在线心跳：45s TTL、连接每 10s 上报、服务端每 5s 统计变化即广播 |
| `ephemeral` | 存储压力降级后的「仅实时」模式：可聊可看，但没有历史 |
| 禁言不禁看 | IP 被封后不能发消息，但仍能看（已开的流不断、历史可读） |
