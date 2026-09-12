import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/**
 * Vercel Node accepts only a Web handler ({ fetch }), named GET/POST exports, or a framework
 * instance with .fetch; a bare function export is called as legacy (req,res) and never flushes.
 */

const mod = (await import("../../src/index")) as unknown as {
  default: unknown;
};

const CLIENT = "11111111-2222-4333-8444-555555555555";

// env must be saved/restored around this file: bun shares process.env across test files
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
  // warm the lazy singleton while env is set
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
