import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/**
 * Vercel 入口形态回归护栏：锁定入口导出形态，避免整站请求挂起。
 *
 * Vercel Node 运行时的 Web handler 只接受：
 *   1. `export default { fetch(request) }`
 *   2. 具名 `export const GET/POST/...`
 *   3. 自带 `.fetch` 的框架实例（如 `export default honoApp`）
 * 裸函数 `export default async (req) => Response` 会被当成旧式 `(req, res)` 处理器：
 * 函数不写 `res` → 响应永不返回 → 整站 0 字节挂起直到函数超时（连静态页也挂，
 * 因为 vercel.json 的 catch-all 把所有路由都指向该函数）。
 *
 * 本文件同时充当"按 Vercel 调用约定"的烟测：直接以 Web `Request` 调用
 * `mod.default.fetch(...)`，即运行时真正走的路径（不经过 Bun.serve）。
 */

const mod = (await import("../../src/index")) as unknown as {
  default: unknown;
};

const CLIENT = "11111111-2222-4333-8444-555555555555";

/** 环境隔离：只在本文件的测试窗口内设置 env（bun 按文件顺序执行，afterAll 先于下个文件），
 *  且在 beforeAll 里完成首次调用把 app 实例缓存住，afterAll 立刻归还 env。 */
const KEYS = [
  "DB_PROVIDER",
  "DATABASE_URL",
  "NODE_ENV",
  "ADMIN_SECRET",
] as const;
let saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.DB_PROVIDER = "memory";
  process.env.DATABASE_URL = "";
  process.env.NODE_ENV = "development";
  process.env.ADMIN_SECRET = "entry-test-secret";
  // 预热：入口懒建单例在此完成，后续断言不再依赖 process.env
  await (mod.default as { fetch: (r: Request) => Promise<Response> }).fetch(
    new Request("http://localhost/api/meta"),
  );
});

afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("Vercel 入口导出形态", () => {
  test("default 是带 fetch 方法的对象（web handler），不是裸函数", () => {
    const d = mod.default as { fetch?: unknown };
    expect(typeof mod.default).toBe("object");
    expect(typeof d.fetch).toBe("function");
    // 裸函数形态会命中这里（会被当作旧式 (req, res) 处理器调用）
    expect(typeof mod.default).not.toBe("function");
  });

  test("fetch(Request) 走完整 app：/api/meta 200", async () => {
    const { fetch } = mod.default as {
      fetch: (r: Request) => Promise<Response>;
    };
    const res = await fetch(new Request("http://localhost/api/meta"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      client_ip?: string;
      limits?: { nick_max?: number; text_max?: number };
    };
    expect(typeof body.client_ip).toBe("string");
    expect(body.limits?.nick_max).toBe(24);
    expect(body.limits?.text_max).toBe(1000);
  });

  test("fetch(Request) 静态页与写链路都可用（同函数承接全部路由）", async () => {
    const { fetch } = mod.default as {
      fetch: (r: Request) => Promise<Response>;
    };
    const page = await fetch(new Request("http://localhost/demo.html"));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");

    const post = await fetch(
      new Request("http://localhost/api/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: CLIENT,
          nick: "入口",
          text: "形态烟测",
        }),
      }),
    );
    expect(post.status).toBe(201);

    const list = await fetch(
      new Request("http://localhost/api/messages?limit=5"),
    );
    expect(list.status).toBe(200);
    const j = (await list.json()) as {
      messages: Array<{ text: string | null }>;
    };
    expect(j.messages.some((m) => m.text === "形态烟测")).toBe(true);

    const root = await fetch(new Request("http://localhost/"));
    expect([200, 302]).toContain(root.status);
  });
});
