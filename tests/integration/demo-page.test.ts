import { describe, expect, test, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { renderPage } from "../../src/routes/pages";
import { makeApp } from "../helpers";

/** Runs public/demo.html inline JS in a minimal DOM shim, with the real app as backend. */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function createDom() {
  const listeners: Record<string, ((e?: any) => void)[]> = {};
  const byId = new Map<string, any>();
  const make = (tag = "div") => {
    const el: any = {
      tagName: tag.toUpperCase(),
      className: "",
      textContent: "",
      value: "",
      maxLength: 0,
      dataset: {},
      children: [] as any[],
      parent: null as any,
      addEventListener() {},
      focus() {},
      append(...kids: any[]) {
        for (const k of kids) {
          k.parent = el;
          el.children.push(k);
        }
      },
      prepend(kid: any) {
        kid.parent = el;
        el.children.unshift(kid);
      },
      remove() {
        const p = el.parent;
        if (p) p.children.splice(p.children.indexOf(el), 1);
      },
      querySelector: () => null,
      get lastChild() {
        return el.children[el.children.length - 1] ?? null;
      },
    };
    return el;
  };
  const document = {
    visibilityState: "visible",
    getElementById(id: string) {
      if (!byId.has(id)) byId.set(id, make(id === "messages" ? "ul" : "div"));
      return byId.get(id);
    },
    createElement: (tag: string) => make(tag),
    addEventListener(type: string, fn: (e?: any) => void) {
      (listeners[type] ||= []).push(fn);
    },
  };
  const setVisibility = (state: string) => {
    document.visibilityState = state;
    for (const fn of listeners.visibilitychange ?? []) fn();
  };
  return { document, byId, setVisibility };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await tick(10);
  }
  return cond();
}

async function bootDemo() {
  const h = await makeApp();
  cleanups.push(h.cleanup);
  const { app } = h;
  let streamOpens = 0;
  let streamAborts = 0;
  let messageFetches = 0;

  // Synthetic SSE body: emits one presence frame, then ends when the page aborts it.
  const streamFetch = (signal?: AbortSignal) => {
    streamOpens++;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('event: presence\ndata: {"online":1}\n\n'),
        );
        signal?.addEventListener("abort", () => {
          streamAborts++;
          controller.close();
        });
      },
    });
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
  };
  const fetchShim = async (path: string, opts: any = {}) => {
    if (path.startsWith("/api/stream")) return streamFetch(opts.signal);
    if (path.startsWith("/api/messages")) messageFetches++;
    return app.request(path, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
    });
  };

  // Render like production: {{tokens}} resolved and window.COPY injected.
  const html = renderPage(
    readFileSync(new URL("../../public/demo.html", import.meta.url), "utf8"),
  );
  // Bootstrap script first, page script second (it reads window.COPY).
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .join("\n");
  const dom = createDom();
  new Function("document", "window", "fetch", code)(
    dom.document,
    {},
    fetchShim,
  );

  return {
    dom,
    stats: () => ({ streamOpens, streamAborts, messageFetches }),
  };
}

describe("聊天页·页面可见性联动（服务器成本）", () => {
  test("页面隐藏即断开流，不重连；恢复可见后重连并补历史", async () => {
    const d = await bootDemo();
    expect(await until(() => d.stats().streamOpens === 1)).toBe(true);
    const afterLoad = d.stats().messageFetches;

    d.dom.setVisibility("hidden");
    expect(await until(() => d.stats().streamAborts === 1)).toBe(true);
    // Longer than the pause loop's sleep: a hidden page must not reopen the stream.
    await tick(1200);
    expect(d.stats().streamOpens).toBe(1);

    d.dom.setVisibility("visible");
    expect(await until(() => d.stats().streamOpens === 2)).toBe(true);
    expect(d.stats().messageFetches).toBeGreaterThan(afterLoad);
  });

  test("以隐藏状态打开时不建流，首次可见才连接", async () => {
    const d = await bootDemo();
    d.dom.setVisibility("hidden");
    await tick(100);
    expect(d.stats().streamOpens).toBe(0);
    d.dom.setVisibility("visible");
    expect(await until(() => d.stats().streamOpens === 1)).toBe(true);
  });
});
