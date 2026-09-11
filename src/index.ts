import { buildApp } from "./app";
import type { Hono } from "hono";

/**
 * 懒建单例：Vercel 冷启动时首个请求才连库/建表（createApp 内部对首请求做幂等 bootstrap），
 * 避免 import 期执行 DB 副作用；Bun dev 分支直接 await 同一工厂（无二次执行）。
 */
let state: { app: Hono } | null = null;
const getApp = async () => {
 state ??= { app: (await buildApp()).app };
 return state.app;
};

if (import.meta.main) {
 // 不用顶层 await：@vercel/node 产物可能被转译为 CJS，模块顶层 await 会破坏构建；
 // .then 形式下 Bun.serve 启动时机等价（仍在事件循环内立刻起服务）。
 void buildApp().then(({ cfg, app }) => {
  const server = Bun.serve({
   port: cfg.port,
   fetch: app.fetch,
   // Bun.serve idleTimeout 上限 255s（计划写 300 会被 Bun 拒绝——简报硬伤）。
   // SSE 流长连依赖 runStream 心跳（空闲 >heartbeatMs=15s 发 ": ping"）保活，
   // 本项只是兜底，须 >heartbeatMs 防误杀，故取 Bun 允许最大值 255。
   idleTimeout: 255,
  });
  console.log(
   `weblive-chat dev server → http://localhost:${server.port}/demo.html`,
  );
 });
}

/**
 * Vercel @vercel/node 入口（单函数承接全部路由）。
 *
 * 线上事故根因（2026-09-11 排查）：原先导出**裸函数**
 * `export default async (req: Request) => Response`。Vercel Node 运行时的 Web handler
 * 只认三种形态：`export default { fetch(request) }`、具名 `export const GET/POST/...`、
 * 或自带 `.fetch` 的框架实例（如 Hono app）。裸函数会被当作**旧式 `(req, res)` 处理器**调用，
 * 而本函数从不写 `res`，于是响应永不下发——表现为整站请求 0 字节挂起直至函数超时（含静态页，
 * 因所有路由都走本函数）。改回官方 `{ fetch }` 形态即修复。
 * 回归护栏见 tests/integration/vercel-entry.test.ts（锁死导出形态）。
 */
export default {
 async fetch(request: Request): Promise<Response> {
  const app = await getApp();
  return app.fetch(request);
 },
};
