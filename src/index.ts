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
 const { cfg, app } = await buildApp();
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
}

/**
 * Vercel @vercel/node 入口（单函数承接全部路由）。
 *
 * 简报硬伤 + Ruling：计划写 `import { handle } from "hono/node-serverless"`，但 hono 4.13.7
 * 的 exports 不含 node-serverless 子路径；其替代 `hono/vercel` 的 handle(app) 要求**立即持有**
 * Hono 实例（`(req) => app.fetch(req)`），会破坏上面的懒 boot。故此处直接导出等价的懒转发
 * 函数——形态与 hono/vercel handle 返回值一致（Web Request→Response），@vercel/node 可承接。
 * 云端上线验收（vercel deploy 后 SSE 300s 重连等）记入规格 §10 回归清单，不阻塞本地验收。
 */
export default async (req: Request): Promise<Response> =>
 (await getApp()).fetch(req);
