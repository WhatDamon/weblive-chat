# weblive-chat 优化路线图（总索引）

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 按已审查通过的优化清单（A 正确性 / B 性能 / C 安全 / D 可观测性 / E 架构 / F 工程化）分六个阶段落地，每个阶段独立可发布。

**架构：** 不做大重构。所有改动沿现有 seam 下沉：新增 `src/lib/log.ts`、`metrics.ts`、`maintenance.ts`、`events.ts`、`ports.ts` 五个小模块，其余修改落在既有模块内部；存储层仍由三个方言 adapter 实现同一 `Repo` 契约。

**技术栈：** Bun 1.3+ / TypeScript（ES2022, strict, verbatimModuleSyntax）/ Hono 4 / libsql + postgres.js / `bun test` / Biome / GitHub Actions。

**规格：** 本路线图源自 2026-10-18 的代码库审查（结论记录在提交历史与本次对话），并受 `docs/design.md` 的 D1–D16 ADR 约束；实现时两份都要读。

---

## 全局约束

- 运行环境双栈：开发/测试用 Bun，线上 Vercel 用 Node；`src/` 里不得引入 Bun 专有 API（`Bun.serve` 仅限 `src/index.ts` 的 `import.meta.main` 分支）。
- 不引入 ORM、不引入 WebSocket、不把轮询/presence 节拍暴露成 env（D1–D16 已否决，不要重新提议）。
- 保持零构建：`public/*.html` 由服务端占位符渲染，不引入打包器。
- 所有面向用户的文案（错误、页面、审计提示）必须经 `src/lib/copy.ts`；API 错误码必须是 `COPY.error` 的键（编译器会强制 `ErrCode`）。
- SQL 仍是可移植子集：模板用 `?` 占位符，Postgres 侧由 `toPgParams` 改写并补 `RETURNING`；新增 SQL 必须在 `tests/integration/repo.test.ts` 的契约套件里对 sqlite 与 memory 双跑通过。
- 每个任务结束时 `bun test`（基线 128 个用例）与 `bun run typecheck` 必须全绿。
- 提交信息用中文 Conventional Commits，与仓库现有风格一致（`feat(安全): …`、`fix(流): …`、`perf(额度): …`）。
- 单个任务一个 commit；不把多个任务的改动混进同一个 commit。

## 审查重点（Review Focus）

| # | 输入 / 条件 | 正常人期待的行为 | 钉住它的测试 |
|---|---|---|---|
| 1 | POST 请求体 20KB–4MB，或 `content-length` 缺失的 chunked 体 | 立刻 413 `payload_too_large`，不解析完整 JSON、不占内存 | T02.6 `app.chat.test.ts` |
| 2 | 畸形 IP：`999.1.1.1`、`::::`、`::ffff:1.2.3.4`、空 XFF | 非 IP 一律判非法；mapped 形式归一为 IPv4；XFF 全非法时回退 `devIp` | T03.2 `security.test.ts` |
| 3 | purge 令牌：跨 60s 窗口重放、`full` 清空后重放、scope/ip 不匹配 | 一律 400 `invalid_token`，数据不再被删一次 | T02.3 `admin.test.ts` |
| 4 | `?since=0`、`?since=` 非法值、`since` 恰等于 `events` 最大 id | `since=0` 从最早升序返回；非法值按缺省；等于 maxId 不丢事件 | T02.1 `app.chat.test.ts`；T04.9 `stream.test.ts`（游标推进不丢） |
| 5 | DB 不可用时的页面与 API 请求 | `/demo.html` `/admin` 仍 200 并带缓存头；`/api/*` 503 且带 `x-request-id`，服务端有日志 | T02.4 + T01.2 |

---

## 文件结构（新增 / 主要修改）

| 文件 | 职责 | 阶段 |
|---|---|---|
| `biome.json`、`bunfig.toml`、`.github/workflows/ci.yml`、`tsconfig.node.json` | 格式、覆盖率门槛、CI、双运行时分型 | 00 / 05 |
| `src/lib/log.ts` | 结构化日志：`logError` / `logInfo` / `newRequestId` | 01 |
| `src/lib/metrics.ts` | 进程内计数：`activeStreams`、`dbErrors`、`maintenanceRuns` | 01 |
| `src/routes/health.ts` | `GET /api/health`（DB probe + provider + mode） | 01 |
| `src/lib/maintenance.ts` | 写入计数 → 后台维护调度器（`hit()` / `flush()`） | 04 |
| `src/lib/events.ts` | 唯一的事件载荷构造函数（message / delete / notice） | 05 |
| `src/lib/ports.ts` | `Repo` 拆出的窄接口（MessageStore / EventOutbox / …） | 05 |
| `public/retry.js` | 重连退避公式（页面与服务端测试共用同一份） | 04 |
| `src/lib/config.ts` | 新增 `historyPerMin`、pg 连接参数、`adminRequireOrigin`、生产口令策略、空字符串路径兜底 | 02 / 03 / 04 |
| `src/lib/repo.ts` | `ping`、`idAtOffset`、`softDeleteMessageAndEvent`、ephemeral 单写、pg options、`purge_used` 豁免 | 01 / 02 / 04 |
| `src/lib/history.ts` | 统计缓存、offset 裁剪、注入时钟 | 04 / 05 |
| `src/lib/stream.ts` | 错误脱敏、`retry:` 帧、单 tick 排空、注入时钟 | 01 / 04 / 05 |
| `src/routes/chat.ts` / `admin.ts` / `pages.ts` / `app.ts` | 游标语义、限流桶、Origin 策略、CSP、渲染缓存、维护调度 | 全阶段 |
| `tests/*` | 每个任务先写失败测试；契约套件双跑 sqlite + memory | 全阶段 |

**为什么这样切：** 每个阶段结束时软件都可运行、可测试、可部署。00 让后续所有改动有守卫；01 让 02–05 的失败可诊断；02/03 是"止血"；04 是成本；05 才是结构性改动，放在有回归网之后。

---

## 阶段计划

| 阶段 | 计划文件 | 覆盖项 | 任务数 | 独立验收 |
|---|---|---|---|---|
| 00 基线工具 | [`2026-10-18-p00-baseline.md`](./2026-10-18-p00-baseline.md) | F2, F1, F3, F4 | 3 | CI 在 PR 上跑绿；全仓格式统一 |
| 01 可观测性 | [`2026-10-18-p01-observability.md`](./2026-10-18-p01-observability.md) | D1, D2, D3, D4, A4 | 5 | 任何 503 都能在日志里定位到 request id |
| 02 正确性 | [`2026-10-18-p02-correctness.md`](./2026-10-18-p02-correctness.md) | A1, A2, A3, A5, A6, A7 | 6 | 契约与文档一致；禁词默认生效；purge 令牌不可重放 |
| 03 安全加固 | [`2026-10-18-p03-security.md`](./2026-10-18-p03-security.md) | C1, C2, C3, C5, C6, C7, C4/C8, B9 | 6 | 响应头齐全；管理写操作拒绝跨站；历史有限流 |
| 04 性能与成本 | [`2026-10-18-p04-performance.md`](./2026-10-18-p04-performance.md) | B1, B2, B3, B4, B5, B6, B7, B8, B10 | 9 | 触顶维护不再全表读；写路径无同步清理 |
| 05 架构收尾 | [`2026-10-18-p05-architecture.md`](./2026-10-18-p05-architecture.md) | E1, E2, E4, E5, F5, F7, F8 | 7 | 路由只依赖窄接口；`any` 清零；类型双跑 |

（E3 已并入 T02.5；E6 结论是"保留不动"，无任务。）

**硬依赖：** 01 依赖 00；02 依赖 01（错误脱敏要用 `logError`）；03/04/05 依赖 02。03 与 04 之间无依赖，可并行；05 依赖 04（`events.ts` 要吸收 04 的 ephemeral id 生成，`ports.ts` 要覆盖 04 新增的 `idAtOffset`/`ping`）。

**建议执行顺序：** 00 → 01 → 02 → 03 → 04 → 05。若只想先止血，做完 00/01/02 即可发布。

---

## 每个阶段的完成定义

1. 该阶段所有任务的复选框勾完，且每条 commit 独立可回滚。
2. `bun test` 全绿，用例数只增不减；`bun run typecheck` 无输出。
3. `bunx biome check .` 无 error。
4. 该阶段涉及的 `docs/api.md` / `docs/integration.md` / `README.md` / `.env.example` 已同步，不留"文档说 A、代码做 B"。
5. 该阶段新增的 env 变量都进了 `.env.example` 与 README 的变量表。

## 自检结果（本计划对审查清单的覆盖）

- 正确性 A1–A7 → T02.1–T02.6（A4 移入 T01.3，因为要与日志一起改）。
- 性能 B1–B10 → T04.1–T04.7、T04.8、T04.9（B5 并入 T04.1，B9 并入 T03.1，B10 为 T04.9）。B1/B2/B3 的"不再全表读"由 `tests/unit/history.test.ts` 的调用计数断言钉住。
- 安全 C1–C8 → T03.1–T03.6。
- 可观测性 D1–D4 → T01.1–T01.5。
- 架构 E1–E5 → T05.1–T05.4；E6 明确保留。
- 工程化 F1–F8 → T00.1–T00.3、T05.5–T05.7。
- 无遗漏项；无"待定"步骤；跨任务引用的类型名已在 05 的 Interfaces 段固定。
