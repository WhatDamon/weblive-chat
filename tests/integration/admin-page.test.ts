import { describe, expect, test, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { renderPage } from "../../src/routes/pages";
import { makeApp } from "../helpers";

/** Runs public/admin.html inline JS in a minimal DOM shim, with the real app as backend. */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function createDom() {
  const byId = new Map<string, any>();
  const radios = [
    { name: "pScope", value: "chat", checked: true, onchange: null as any },
    { name: "pScope", value: "full", checked: false, onchange: null as any },
  ];
  const make = (tag = "div") => {
    const el: any = {
      tagName: tag.toUpperCase(),
      style: {},
      className: "",
      textContent: "",
      value: "",
      disabled: false,
      children: [] as any[],
      onclick: null as any,
      onchange: null as any,
      append(...kids: any[]) {
        el.children.push(...kids);
      },
      addEventListener() {},
      removeEventListener() {},
    };
    return el;
  };
  const document = {
    getElementById(id: string) {
      if (!byId.has(id)) byId.set(id, make());
      return byId.get(id);
    },
    querySelectorAll(sel: string) {
      return sel.includes("pScope") ? radios : [];
    },
    querySelector(sel: string) {
      if (sel.includes("pScope")) return radios.find((r) => r.checked) ?? null;
      return null;
    },
    createElement(tag: string) {
      return make(tag);
    },
  };
  return { document, radios, byId };
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function bootPage(
  over: any = {},
  opts: { origin?: string; location?: string } = {},
) {
  const h = await makeApp(over);
  cleanups.push(h.cleanup);
  const { app } = h;

  // cookie jar: the page relies on the browser sending wl_admin
  let cookie = "";
  const fetchShim = async (path: string, opts2: any = {}) => {
    const headers = {
      ...(opts2.headers ?? {}),
      ...(cookie ? { cookie } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
    };
    const res = await app.request(path, { ...opts2, headers });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return res;
  };
  const alerts: string[] = [];
  const confirms: string[] = [];
  let confirmAnswer = false;
  const windowShim = {
    confirm(msg: string) {
      confirms.push(String(msg));
      return confirmAnswer;
    },
  };

  // render like production: {{tokens}} resolved and window.COPY injected
  const html = renderPage(
    readFileSync(new URL("../../public/admin.html", import.meta.url), "utf8"),
  );
  // bootstrap script first, page script second (it reads window.COPY)
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .join("\n");
  const dom = createDom();
  const locationShim = {
    origin: opts.location ?? "http://localhost:3000",
    href: (opts.location ?? "http://localhost:3000") + "/admin",
  };
  new Function(
    "document",
    "window",
    "location",
    "fetch",
    "alert",
    "setInterval",
    "clearInterval",
    code,
  )(
    dom.document,
    windowShim,
    locationShim,
    fetchShim,
    (m: string) => alerts.push(String(m)),
    setInterval,
    clearInterval,
  );

  return {
    app,
    dom,
    alerts,
    confirms,
    setConfirm: (v: boolean) => {
      confirmAnswer = v;
    },
    post: (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

describe("后台页·清空数据（DOM shim 驱动真实页面逻辑）", () => {
  test("完整链路：预检 → 延迟可用 → 短语/口令 → 二次确认可取消 → 执行 → 令牌作废", async () => {
    const p = await bootPage();
    const { dom, alerts, confirms } = p;
    const el = (id: string) => dom.document.getElementById(id);

    await tick(); // let the init IIFE (/api/meta + refreshAuth) settle
    el("secret").value = "test-secret";
    await el("loginBtn").onclick();
    expect(el("login").style.display).toBe("none");
    expect(el("panels").style.display).toBe("block");

    const seeded = await p.post("/api/messages", {
      client_id: "11111111-2222-4333-8444-555555555555",
      nick: "n",
      text: "待清空",
    });
    expect(seeded.status).toBe(201);

    await el("pPreviewBtn").onclick();
    expect(el("pRun").style.display).toBe("block");
    expect(el("pPhrase").textContent).toBe("清空聊天记录");
    expect(el("pSummary").textContent).toContain("消息 1");
    expect(el("pSummary").textContent).toContain("封禁名单");
    expect(el("pGoBtn").disabled).toBe(true);
    await tick(300); // the countdown text is written inside the interval callback
    expect(el("pGoHint").textContent).toContain("秒后可确认");

    await tick(3300); // past the 3s unlock delay
    expect(el("pGoBtn").disabled).toBe(false);
    expect(el("pGoHint").textContent).toContain("重新预检");

    el("pConfirm").value = "清空聊天";
    el("pSecret").value = "test-secret";
    await el("pGoBtn").onclick();
    expect(alerts.at(-1)).toContain("确认短语不匹配");
    expect(
      (await (await p.app.request("/api/messages?limit=5")).json()).messages,
    ).toHaveLength(1);

    el("pConfirm").value = "清空聊天记录";
    p.setConfirm(false);
    await el("pGoBtn").onclick();
    expect(confirms.at(-1)).toContain("不可撤销");
    expect(
      (await (await p.app.request("/api/messages?limit=5")).json()).messages,
    ).toHaveLength(1);

    p.setConfirm(true);
    await el("pGoBtn").onclick();
    expect(alerts.at(-1)).toContain("已清空");
    expect(alerts.at(-1)).toContain("消息 1");
    expect(
      (await (await p.app.request("/api/messages?limit=5")).json()).messages,
    ).toHaveLength(0);
    expect(el("pRun").style.display).toBe("none");
    expect(el("pGoBtn").disabled).toBe(true);

    await el("pGoBtn").onclick();
    expect(alerts.at(-1)).toContain("请先预检");
  }, 20_000);

  test("切换档位即作废令牌；full 档下发不同短语与更宽的删除面", async () => {
    const p = await bootPage();
    const { dom } = p;
    const el = (id: string) => dom.document.getElementById(id);
    await tick();
    el("secret").value = "test-secret";
    await el("loginBtn").onclick();

    await el("pPreviewBtn").onclick();
    expect(el("pRun").style.display).toBe("block");

    dom.radios[0].checked = false;
    dom.radios[1].checked = true;
    dom.radios[1].onchange();
    expect(el("pRun").style.display).toBe("none");
    expect(el("pConfirm").value).toBe("");

    await el("pPreviewBtn").onclick();
    expect(el("pPhrase").textContent).toBe("清空全部数据");
    expect(el("pSummary").textContent).toContain("封禁名单");
    expect(el("pSummary").textContent).toContain("保留：无");
  }, 20_000);

  test("Origin 被拒时后台页给出可执行提示（而不是干巴巴的「来源不被允许」）", async () => {
    const p = await bootPage(
      { allowedOrigins: ["https://old.example"] },
      {
        origin: "https://livechat.damon233.top",
        location: "https://livechat.damon233.top",
      },
    );
    const el = (id: string) => p.dom.document.getElementById(id);
    await tick();
    el("secret").value = "test-secret";
    await el("loginBtn").onclick();
    const msg = p.alerts.at(-1)!;
    expect(msg).toContain("ALLOWED_ORIGINS");
    expect(msg).toContain("https://livechat.damon233.top");
    expect(msg).toContain("留空");
  }, 20_000);
});
