# WebLive Chat

免登录、可**直接部署到 Vercel** 的实时聊天后端：通过 SSE + POST 向多个前端广播消息与**在线人数**，可配置的聊天记录持久化（超限自动收缩/降级），并内置管理页供管理员**禁言封禁 IP** 与软删违规消息。

```
┌──────────────┐  POST /api/messages   ┌───────────────────────────┐
│  任意前端      │ ─────────────────────▶│      Hono App（单函数）      │
│ demo.html /  │                       │  Bun 本地 / Vercel Node    │
│ 自建网页/小程序 │  GET /api/stream ◀────│  chat / admin / 静态页      │
└──────────────┘    (SSE 事件流)        └────────────┬──────────────┘
                                                     ▼
                                  ┌──────────────────────────────┐
                                  │  SQLite（Turso）｜ PostgreSQL   │
                                  │  messages / events / presence /│
                                  │  bans / rate_limits            │
                                  └──────────────────────────────┘
```

- **免登录**：客户端自持 `client_id`（UUID，无账号体系）；部署者通过环境变量配置管理员口令。
- **实时**：`GET /api/stream` SSE 事件流 + `POST /api/messages`；`since` 游标自动续传（断线重连不丢事件）。
- **在线人数**：按 `client_id` 去重（同浏览器多标签 = 1 人），45s TTL 心跳窗口，每 ~5s 检测一次、**人数变化时才广播**（无变化不推）。
- **管理**：内置零构建 `/admin` 页面与 JSON API——口令登录、封禁/解封 IP（**禁言不禁看**）、软删消息、查看在线/历史/stats。
- **持久化可选降级**：`events` 出站表保证实时广播，`messages` 历史表按「天数 × 行数」双控滚动保留；接近上限自动逐级收缩保留期，触顶自动切 `ephemeral`（仅实时、停写历史）并广播 `notice`。
- **防滥用**：每 IP 分桶限流（消息/开流/登录）、昵称/内容长度上限、可选禁词（子串匹配）。
- **可移植存储**：`DB_PROVIDER` 一键切换 SQLite（本地 `file:` / 生产 Turso）或任意 Postgres（Neon / Supabase / 自托管）——业务与 API 契约代码零改动。

技术栈：Bun（本地开发/运行）、Hono（双运行时：Bun.serve + Vercel Node）、SSE；存储层为**手写可移植 SQL**（`@libsql/client` / `postgres.js`，不引入 ORM，建表走启动幂等 DDL）。

## 快速开始

前置：Bun ≥ 1.2（部署到 Vercel 无需本地 Bun）。

```bash
bun install
cp .env.example .env          # 本地默认 file: SQLite，零外部依赖
bun run dev                   # http://localhost:3000
```

- 聊天室：<http://localhost:3000/demo.html>（实时推送、历史记录、在线人数）
- 管理后台：<http://localhost:3000/admin>（本地开发未设置 `ADMIN_SECRET` 时使用内置开发口令；生产环境必须显式配置）——含运行状态、IP 封禁、消息软删，以及需多重校验的危险操作「清空数据」

常用命令：

| 命令 | 说明 |
|---|---|
| `bun run dev` | 本地热重载开发服务器 |
| `bun run start` | 本地单次启动（同 dev 无热重载） |
| `bun test` | 全部测试（默认使用本地文件 SQLite） |
| `bun run test:pg` | 同一套集成测试跑 Postgres（需先设 `DATABASE_URL`） |
| `bun run typecheck` | `tsc --noEmit` 类型检查 |
| `bun tests/e2e/smoke.ts` | 端到端冒烟（真实启动服务器，覆盖跨功能链路） |
| `bun examples/client.mjs [地址] [昵称]` | 独立示例客户端，连本地或线上部署（详见 `docs/integration.md`） |

## 环境变量

全部通过环境变量配置，仓库不存任何密钥（只提交 `.env.example`）。

| 变量 | 默认 | 说明 |
|---|---|---|
| `DB_PROVIDER` | `sqlite` | `sqlite` ｜ `postgres` ｜ `memory` |
| `DATABASE_URL` | `file:./data/dev.db` | 见下「存储形态」；`postgres` 时必须为 `postgres://…`；`memory` 时忽略 |
| `TURSO_AUTH_TOKEN` | 空 | 仅 Turso（`libsql://`）需要 |
| `ADMIN_SECRET` | 仅本地开发有内置回退值 | 管理后台口令；**生产（`NODE_ENV=production`）缺失即拒绝启动**，请设为长随机串 |
| `NODE_ENV` | `development` | Vercel 自动设为 `production` |
| `ALLOWED_ORIGINS` | 空（开放） | 逗号分隔精确 Origin，如 `https://a.com,http://localhost:3000`；一旦设置即白名单 fail-closed。写 `*` 等价于留空（全开），不会被当成字面量来源。⚠️ **设置时须把部署自身域名一并列入**（同源 `/demo.html`、`/admin` 页与同源前端，浏览器对 POST 必带 Origin），否则内置页面/同源应用的写请求会被 403 拒；**换域名后必须同步更新此变量**（改完需重新部署才生效） |
| `REQUIRE_ORIGIN` | `0` | `1` 时无 Origin 的直连（curl/脚本）也拒绝（`403 missing_origin`） |
| `NICK_MAX` | `24` | 昵称最大字符数 |
| `TEXT_MAX` | `1000` | 消息内容最大字符数 |
| `BANNED_WORDS_MODE` | `basic` | 违禁词库启用范围：`off`（仅显式词）/ `basic`（内置精选词表）/ `strict`（再加载 `data/banned/strict/`） |
| `BANNED_WORDS_DIR` | `<cwd>/data/banned` | 词库目录；`basic/` 必选，`strict/` 仅 strict 模式加载 |
| `BANNED_WORDS` | 空 | 显式追加禁词（逗号分隔，与词库合并） |
| `BANNED_WORDS_ALLOW` | 空 | 白名单：命中区间被其覆盖时豁免，如 `赌博合法` |
| `HISTORY_RETENTION_DAYS` | `90` | 历史保留天数上限（自动逐级收缩 90→30→10→3→1） |
| `HISTORY_MAX_ROWS` | `500000` | 历史行数上限（接近上限收缩；到达硬顶切 `ephemeral` 仅实时） |
| `HISTORY_MAX_BACKFILL` | `0` | 历史回溯深度上限；`0` = 不限制（任何人可翻全量历史） |
| `MSG_RATE_PER_MIN` | `10` | 每 IP 每分钟可发消息数（60s 固定窗口） |
| `STREAM_RATE_PER_MIN` | `20` | 每 IP 每分钟可开流数 |
| `LOGIN_RATE_PER_MIN` | `5` | 每 IP 每分钟登录尝试数 |
| `PURGE_RATE_PER_MIN` | `5` | 每 IP 每分钟危险操作（清空数据）次数：**预检与执行共用同一桶** |
| `MAINTENANCE_EVERY` | `100` | 每 N 次写入触发一次保留期评估与过期清理 |
| `DEV_IP` | `127.0.0.1` | 无 `x-forwarded-for` 时的回退 IP（仅本地开发/测试） |
| `ADMIN_SESSION_DAYS` | `7` | 管理会话 Cookie 有效天数 |
| `PORT` | `3000` | 本地开发服务器端口（Vercel 忽略） |

> 内部固定常量（不可配）：presence TTL 45s、presence 写入 20s 一次、在线人数 5s 一算、活跃轮询 1s（静默 30s 后转 3s）、心跳 15s、events 出站表保留 1h。

### 违禁词过滤

内置精选词库在 `data/banned/basic/`（色情 291 / 辱骂 46 / 涉枪涉爆 434 / 诈骗广告 111，共 882 条），来源 [konsheng/Sensitive-lexicon](https://github.com/konsheng/Sensitive-lexicon)（MIT）＋本项目人工增补。**刻意不做整包导入**：源词库面向文本审核，含「兼职 / 招聘 / 客服 / 按摩 / 刺激」这类常用词，直接启用会大面积误伤；裁剪规则见 `data/banned/README.md`。

- 匹配前先归一化（全角转半角、英文小写、剔除零宽字符与标点空白），「赌　博」「赌\*博」这类插空绕过无效；词长下限 2 字
- 昵称与消息内容都受检；命中只回「内容含违禁词」，**不回显命中的词**
- 误伤用 `BANNED_WORDS_ALLOW` 豁免（改环境变量即时生效），或直接删除词库文件中对应词条
- 政治 / 暴恐 / 大表类词库默认不随仓库分发：需要时按 `data/banned/strict/README.md` 放入并设 `BANNED_WORDS_MODE=strict`
- 部署提示：`vercel.json` 已把 `data/**` 打进函数（`includeFiles`）；目录缺失时服务只降级为「仅显式词」并在日志报错，不会影响发消息

### 存储形态（三种 `DATABASE_URL`）

| 用途 | `DB_PROVIDER` | `DATABASE_URL` |
|---|---|---|
| 本地开发 / 测试 | `sqlite` | `file:./data/dev.db` |
| 本地纯内存演示 / 测试（不持久化） | `memory` | 无需（忽略） |
| 生产 SQLite | `sqlite` | `libsql://<db>-<org>.turso.io` + `TURSO_AUTH_TOKEN` |
| 生产 / 自托管 Postgres | `postgres` | `postgres://user:pass@host:5432/db?sslmode=require` |

> ⚠️ **`memory` 模式仅限本地/单实例演示与测试**：数据在进程内存、重启即空、无跨实例共享。**不适用于 Vercel/Serverless 生产**——多函数实例间收不到彼此消息且数据随实例回收；`NODE_ENV=production` 下设置 `DB_PROVIDER=memory` 会直接拒绝启动。

> ⚠️ **Vercel 函数文件系统是临时的**：`file:` 型 SQLite 只能用于本地，**禁止作为 Vercel 生产存储**（数据会随实例回收丢失）。生产 SQLite 必须走远程 Turso。
>
> ⚠️ **Origin 白名单会锁住内置页面**：一旦设置 `ALLOWED_ORIGINS`，浏览器端写请求（POST/DELETE）会带当前页 Origin——**必须把部署自身域名一并列入**（例如 `https://你的域名`），否则内置 `/demo.html` 的发言与 `/admin` 的封禁/删除都会被 `403 origin_not_allowed` 拒绝（GET 历史/SSE 流不受影响）。
>
> **换域名后务必同步 `ALLOWED_ORIGINS` 并重新部署**（环境变量变更不会自动应用到已有部署）。排查手段：`curl /api/meta` 看 `origin_mode`（`open`/`locked`）；被拒时 403 响应体会回显 `error.origin`（被拒来源）与 `error.allowed_origins_count`（已配置数量），后台页也会直接提示应加入哪个域名。
>
> 注意 `REQUIRE_ORIGIN` 只影响「请求不带 Origin」这一种情况（例如同源 GET、curl），与「来源不在白名单」是两条独立规则：把 `REQUIRE_ORIGIN` 置 0 **不能**解决 `origin_not_allowed`。

换 provider = 改 `DB_PROVIDER` + `DATABASE_URL` 两个值（schema 为跨方言子集，启动自动建表），**无需改代码或跑迁移**。

## 文案

所有用户可见文案（接口错误消息 + 内置聊天页 / 管理页）集中在 **`src/lib/copy.ts`** 一处，改文案只改这个文件：

- 服务端（错误信封、路由提示）直接引用该文件；
- 内置页面在响应时才注入：HTML 中写作 `{{admin.loginBtn}}` 占位符，页面脚本通过 `window.COPY.admin.loginBtn` 读取，带 `{n}` 的模板用 `fill(COPY.admin.purgeWait, { n: 3 })` 填充；
- `tests/unit/copy.test.ts` 会拦住三类失误：页面文件里出现中文（文案回流页面）、`{{...}}` 或 `COPY.x.y` 键名写错、注入脚本失效。

## 部署到 Vercel

本项目是**单函数应用**（`vercel.json` 已配好 `@vercel/node` 构建 `src/index.ts`、`maxDuration: 300`、`public/**` 打进函数），零构建、零手动迁移。步骤：

1. 导入仓库到 Vercel（Framework 任选；构建命令可为空——`vercel.json` 已声明函数构建）。
2. 配置环境变量（必配）：`ADMIN_SECRET`（长随机串）、`DATABASE_URL`、按需 `TURSO_AUTH_TOKEN` / `ALLOWED_ORIGINS` / 限流与保留旋钮。
3. 部署完成后：`https://<你的域名>/demo.html` 自测；`/admin` 进管理页。

Turso 建库参考：

```bash
turso db create weblive-chat
turso db show weblive-chat --url          # → libsql://weblive-chat-<org>.turso.io
turso db tokens create weblive-chat      # → 粘贴到 TURSO_AUTH_TOKEN
```

Neon / Supabase / 自托管 Postgres：连接串形如 `postgres://…?sslmode=require`，`DB_PROVIDER=postgres` 即可。注意 Neon 免费档按 CU 小时计费——长连轮询会让 compute 全天候活跃，建议仅在低流量场景选用。

平台时长提示：Vercel 函数单次最长 300s（Hobby 档；Pro/Enterprise 更高），SSE 流到点断开属**预期行为**——客户端携带 `since` 自动重连续传即可（内置页面已实现）。

### Hobby 免费额度能撑多久

Hobby 档函数**固定 2 GB 内存 / 1 vCPU（不可下调，`vercel.json` 设置内存只会在构建期告警）**，额度为 **360 GB-hr 内存时长 + 4 CPU-hr + 100 万次调用/月**。内存时长按**实例存活且仍有在途请求**计（官方口径：计到最后一个在途请求结束；实例空闲会被冻结、不计费）——所以**一条 SSE 常连 = 实例持续计费**：**360 GB-hr ÷ 2 GB = 180 实例小时/月**，而一个 7×24 常显标签页就是 720 小时/月，**是该额度的 4 倍**。

哪个额度先撞墙？内存。常连按每 tick ≈1.5 ms CPU 计约 **1 CPU-hr/月/连接**（4 CPU-hr ≈ 4 条常连），而内存只够**一条常连跑 7.5 天**——**内存比 CPU 紧约 15 倍**。所以本项目只围绕「减少实例占用时间」做优化，不去微调查询次数：

| 措施 | 效果 |
| --- | --- |
| 页面不可见即断开 SSE（内置 `/demo.html` 已实现，接入方照做即可） | 后台标签页占用归零；恢复可见时带 `since` 重连并补历史 |
| 可见但 5 分钟无操作 → 断开流、转 30s 低频轮询（同样内置） | 忘记关的标签页从 2 GB-hr/小时降到约 0.03–0.1 GB-hr/小时（省 20–60 倍）；一操作就恢复常连 |
| 静默 30s 后轮询 1s → 3s | 冷清房间的 DB 查询与 CPU 唤醒降约 2/3（首帧最坏延迟 3s） |
| presence 写入 20s 一次（TTL 45s 不变） | Turso 免费写入额度下可支撑的在线人数翻倍 |
| `MAX(events.id)` 回退探测 10s 一次 | 空闲连接由 2 次查询/秒降为 1 次/秒 |
| 冷启动建表合并为一次往返（libsql `batch()`） | 每次实例冷启动少 6 次往返 |
| 内置页返回 `s-maxage=300`（API 一律 `no-store`） | 边缘缓存命中的页面浏览完全不计实例时间；缓存不命中也不影响正确性（页面内容每次部署固定） |

**到底能撑多少人？** 全额度 = 每天约 6 小时实例时间（180 h ÷ 30），即 **约 36 人 × 10 分钟「可见且活跃」/天**；由于 Hobby 超限是**暂停功能 30 天**而非扣费，建议留一半余量：**约 18 人 × 10 分钟/天**（或 6 人 × 30 分钟/天）。隐藏标签页与久无操作的页面已被上面的措施降到接近 0，所以这个数字基本就是“真人真正在看”的时长。要突破这个量级只能升 Pro 或把实时通道换成外部总线（设计文档 §7.3）。

结论：**浏览器端「不该连的时候别连」决定了 Hobby 能撑多久**，服务端微调只是余量。若你要几十个常显标签页同时在线，只能改用低频轮询（`/api/messages?since=`）或升 Pro——**前端侧的具体写法与代码请直接给前端开发看 [`docs/quota.md`](docs/quota.md)，接入/契约细节见 [`docs/integration.md`](docs/integration.md) §9.1**。

## 文档

- **接入指南**：`docs/integration.md`（把聊天接进你自己的前端：客户端契约、断线重连、双游标、跨域、排查）
- **前端省额度指南**：`docs/quota.md`（交给前端开发者：可见性/空闲降级、单流保证、退避重连、成本速算与自检清单）
- **API 契约速查**：`docs/api.md`（端点 / SSE 事件 / 错误码 / Origin 白名单 / curl 示例）
- **可运行示例客户端**：`examples/client.mjs`（零依赖，`bun examples/client.mjs <部署地址>` 即可连）
- **完整设计文档**：`docs/design.md`（架构决策、数据模型、容量与成本、测试策略）

## 已知边界与取舍

- **禁词为子串匹配**：对中文易误伤（如禁「赌博」会命中含该子串的任意文本），仅服务端下发、无客户端过滤器。
- **封禁为精确 IP**：同 NAT/CGNAT 下可能波及无辜用户；IPv6 支持但前缀/CIDR 封禁留待后续。
- **`x-forwarded-for` 取首跳**：只有**直连 Vercel**（Vercel 注入且不可伪造）时才可信；若再套 CDN，需按你的 CDN 实际行为调整取跳（前置代理可伪造该头）。
- **历史=公开存档**：免登录设计下，任何人（含未发言者）都能经 `GET /api/messages` 翻阅历史——属公开聊天室的默认形态；用 `HISTORY_MAX_BACKFILL` 可限制回溯深度或直接关闭历史开放。
- **合规提示**：IP 属个人数据。封禁表会留存被封 IP 与原因，请在部署前确认你的用途符合当地法规（可经管理页随时解封；如需彻底清除可直连数据库删除）。

## License

MIT © 2026 Damon Lu
