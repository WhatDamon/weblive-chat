import type { Hono } from "hono";
import { buildApp } from "./app";

/**
 * 应用单例：首个请求才连接存储并建表（createApp 内部做幂等 bootstrap），
 * 避免模块导入期产生 DB 副作用——冷启动与本地开发共用同一工厂。
 */
let state: { app: Hono } | null = null;
const getApp = async () => {
 state ??= { app: (await buildApp()).app };
 return state.app;
};

// 直接运行（bun run dev / bun run start）时启动本地服务器。
// 不用顶层 await：产物可能被转译为 CJS，模块顶层 await 会破坏打包。
if (import.meta.main) {
 void buildApp().then(({ cfg, app }) => {
  const server = Bun.serve({
   port: cfg.port,
   fetch: app.fetch,
   // idleTimeout 上限为 255s（Bun 会拒绝更大的值）。SSE 长连接由心跳保活
   // （空闲超过 heartbeatMs=15s 写出 ": ping"），此项仅作兜底，故取允许的最大值。
   idleTimeout: 255,
  });
  console.log(`WebLive Chat 已启动 → http://localhost:${server.port}/`);
 });
}

/**
 * Vercel 函数入口：单函数承接全部路由（vercel.json 的 catch-all 指向本文件）。
 *
 * 导出形态必须是一个带 `fetch` 方法的对象（Vercel Node 运行时的 Web handler 约定；
 * 具名 `GET`/`POST`/… 或自带 `.fetch` 的框架实例亦等价）。
 * 切勿改为裸函数导出：那会被当作旧式 `(req, res)` 处理器调用，而本函数不写 `res`，
 * 响应将永不下发，表现为整站请求挂起至函数超时。
 * 形态护栏见 tests/integration/vercel-entry.test.ts。
 */
export default {
 async fetch(request: Request): Promise<Response> {
  const app = await getApp();
  return app.fetch(request);
 },
};
