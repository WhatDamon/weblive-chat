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
- `public/retry.js`：可复用的指数退避函数（`backoffDelay`）。

### Changed
- 维护移出请求路径，改为后台调度；统计 60s 缓存。
- ephemeral 消息改为单条 INSERT，id 形如 `e<uuid>`。
- 客户端重连改为指数退避 + 抖动；SSE 下发 `retry: 3000`。
- 单次轮询最多排空 500 条事件，突发不再被 100 条/秒限速。
- `Repo` 拆为 6 个窄接口，路由只依赖所需能力。

### Fixed
- `GET /api/messages?since=0` 现在从最早升序返回。
- `BANNED_WORDS_DIR=` 空值回落到默认目录；零词时告警。
- purge 令牌不可跨窗口/清库后重放。
- 存储故障不再拖垮静态页。
- 删消息与 delete 事件合并为单事务。
- 请求体超过 16KB 返回 413（分块上传边读边限）。
- 流内错误不再把内部异常原文下发给客户端。
- 非法 IP（如 `999.1.1.1`）不再被接受为封禁键。

## [1.0.0] - 2026-09-09

- 首个版本：SSE 实时、三方存储、管理后台、IP 封禁。
