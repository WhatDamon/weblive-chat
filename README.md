# WebLive Chat

免登录、可**一键部署到 Vercel** 的实时聊天后端：SSE + POST 推送消息与在线人数，聊天记录可选持久化（超限自动收缩/降级），内置管理页可封禁 IP、软删消息。

```text
任意前端 ──POST /api/messages──▶  Hono 单函数（Bun 本地 / Vercel Node）
         ◀─GET /api/stream（SSE）─  SQLite（本地 file: / Turso libsql:）｜ PostgreSQL
```

- **免登录**：客户端自持 `client_id`，无账号体系；管理员口令由环境变量配置
- **实时**：`since` 游标断线续传——单次函数运行到点断流后自动重连，不丢事件
- **在线人数**：按 `client_id` 去重（同浏览器多标签算 1 人），人数变化时才广播
- **管理**：内置零构建 `/admin`——口令登录、封禁/解封 IP（**禁言不禁看**）、软删消息、清空数据
- **存储可切换**：`sqlite | postgres | memory`，手写可移植 SQL（无 ORM），启动幂等建表
- **防滥用**：每 IP 分桶限流、昵称/内容长度上限、内置精选违禁词库

技术栈：Bun / Hono / SSE / TypeScript。

## 快速开始

```bash
bun install
cp .env.example .env     # 默认本地 file: SQLite，零外部依赖
bun run dev              # http://localhost:3000
```

聊天页 <http://localhost:3000/demo.html>，管理页 <http://localhost:3000/admin>。本地未设 `ADMIN_SECRET` 时使用内置开发口令，**生产环境必须显式配置**。

| 命令 | 说明 |
| --- | --- |
| `bun run dev` / `bun run start` | 本地热重载开发 / 单次启动 |
| `bun test` | 全部测试（默认本地 SQLite） |
| `bun run test:pg` | 同一套集成测试跑 Postgres（需先设 `DATABASE_URL`） |
| `bun run typecheck` | `tsc --noEmit` |
| `bun tests/e2e/smoke.ts` | 端到端冒烟（真实启动服务器，覆盖跨功能链路） |
| `bun examples/client.mjs [地址] [昵称]` | 零依赖示例客户端 |

## 部署到 Vercel

`vercel.json` 已声明构建（`@vercel/node`、`maxDuration: 300`），**零构建、零迁移**：

1. 导入仓库到 Vercel
2. 配置环境变量：必配 `ADMIN_SECRET`、`DATABASE_URL`（用 Turso 再加 `TURSO_AUTH_TOKEN`）
3. 部署后访问 `https://<域名>/demo.html` 自测，`/admin` 进后台

```bash
turso db create weblive-chat
turso db show weblive-chat --url      # → libsql://… 填入 DATABASE_URL
turso db tokens create weblive-chat   # → TURSO_AUTH_TOKEN
```

⚠️ 函数文件系统是临时的，`file:` 型 SQLite **只能本地用**；生产用 Turso，或 `DB_PROVIDER=postgres` 连 Neon / Supabase / 自托管。切换 provider 只改 `DB_PROVIDER` 与 `DATABASE_URL` 两个变量，启动自动建表，无需改代码或跑迁移。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ADMIN_SECRET` | 仅本地有内置值 | 管理口令；生产缺失即拒绝启动 |
| `DB_PROVIDER` | `sqlite` | `sqlite` ｜ `postgres` ｜ `memory`（仅本地） |
| `DATABASE_URL` | `file:./data/dev.db` | `file:` ｜ `libsql://` ｜ `postgres://` |
| `TURSO_AUTH_TOKEN` | 空 | 仅 Turso（`libsql://`）需要 |
| `ALLOWED_ORIGINS` | 空（开放） | 逗号分隔 Origin，支持 `*.damon233.top` 通配整域；设置后即 fail-closed |
| `REQUIRE_ORIGIN` | `0` | `1` 时无 Origin 的直连（curl/脚本）也拒绝 |
| `NODE_ENV` | `development` | Vercel 自动设为 `production` |

其余可调项（限流、长度上限、历史保留、违禁词、会话天数、维护频率等）见 **[`.env.example`](.env.example)**，每项带注释。

⚠️ **设置 `ALLOWED_ORIGINS` 必须把部署自身域名一并列入**（同源 `/demo.html`、`/admin` 的写请求也带 Origin），否则会 `403 origin_not_allowed`；**换域名后要同步该变量并重新部署**。语法、通配与排查见 [`docs/api.md`](docs/api.md) §3。

## 违禁词

内置精选词表在 `data/banned/basic/`（色情 / 辱骂 / 涉枪涉爆 / 诈骗广告），刻意**不整包导入**源词库以免大面积误伤。匹配在归一化文本上做（全角、大小写、插入字符等绕过无效），命中只回「内容含违禁词」、不回显词条；昵称与内容都受检。增删词条与 `BANNED_WORDS_ALLOW` 豁免见 [`data/banned/README.md`](data/banned/README.md)。

## 文档

- [`docs/integration.md`](docs/integration.md) —— 接入指南：客户端契约、断线重连、双游标陷阱、跨域、排查
- [`docs/api.md`](docs/api.md) —— 接口速查：端点 / SSE 事件 / 错误码 / curl 示例
- [`docs/quota.md`](docs/quota.md) —— 前端接入建议：消耗取决于连接时长，而不是消息量
- [`docs/design.md`](docs/design.md) —— 设计文档：决策摘要、数据模型、容量与成本、测试策略
- [`examples/client.mjs`](examples/client.mjs) —— 零依赖可运行示例客户端

## 已知边界

- **封禁按精确 IP**：NAT/CGNAT 下可能波及同网段用户；支持 IPv6，前缀/CIDR 封禁未实现。
- **`x-forwarded-for` 取首跳**：只有直连 Vercel（该头由平台注入、不可伪造）时才可信；前置了 CDN 需自行调整。
- **历史即公开存档**：免登录设计下任何人都能翻阅历史；可用 `HISTORY_MAX_BACKFILL` 限制回溯深度。
- **合规**：IP 属个人数据，封禁表会留存被封 IP 与原因，部署前请确认用途符合当地法规。

## License

MIT © 2026 Damon Lu
