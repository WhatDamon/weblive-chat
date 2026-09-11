#!/usr/bin/env node
/**
 * WebLive Chat 最小接入示例（零依赖，Bun / Node >= 18 均可运行）
 *
 *   bun examples/client.mjs                                    # 连本机 http://localhost:3000
 *   bun examples/client.mjs https://your-app.vercel.app 昵称    # 连线上部署
 *
 * 演示接入方必须处理好的五件事：
 *   1. client_id 的生成与持久化（浏览器里等价于 localStorage —— 多标签共享同一身份，在线人数按人计）
 *   2. SSE 建流与事件分发（message / delete / presence / notice / ban / error）
 *   3. 断线自动重连：带 since 续传（连接会被平台按函数时限切断，这是正常现象）
 *   4. 重连前用 GET /api/messages?since= 补历史（events 出站表只保留 1 小时）
 *   5. 按 id 去重（since 续传会重放游标之后的事件）+ 静默断链看门狗
 *
 * 详细说明见 docs/integration.md
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.argv[2] ?? "http://localhost:3000").replace(/\/+$/, "");
const NICK = process.argv[3] ?? "示例客户端";
const RECONNECT_MS = 1000; // 断线重连间隔：不要低于 1s，否则容易撞开流限流（默认 20 次/min）
const SEEN_MAX = 5000; // 去重表上限，长连接下防内存增长
const IDLE_MS = 45_000; // 看门狗：45s 没收到任何帧（含 ": ping" 心跳）就重连

/** 浏览器里换成 localStorage 读写即可，语义相同 */
function loadClientId() {
  const file = join(tmpdir(), "weblive-chat-client-id");
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    const id = crypto.randomUUID();
    writeFileSync(file, id);
    return id;
  }
}

export class ChatClient {
  #since = 0; // 流游标：**events.id**（不是 messages.id）
  #lastMessageId = 0; // 历史游标：**messages.id**，用于补洞与翻页
  #seen = new Map(); // 消息 id 去重
  #handlers = new Map();
  #ac = null;
  #closed = true;
  #lastFrame = 0;

  constructor({ base = BASE, clientId = loadClientId(), nick = NICK } = {}) {
    this.base = base.replace(/\/+$/, "");
    this.clientId = clientId;
    this.nick = nick;
  }

  on(type, fn) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, []);
    this.#handlers.get(type).push(fn);
    return this;
  }

  #emit(type, data) {
    for (const fn of this.#handlers.get(type) ?? []) fn(data);
  }

  /** 发言：POST 成功不代表已显示，消息会经 SSE 广播回来（包括自己发的） */
  async send(text) {
    const res = await fetch(`${this.base}/api/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.clientId,
        nick: this.nick,
        text,
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(body?.error?.message ?? `HTTP ${res.status}`);
      err.code = body?.error?.code;
      err.retryAfterMs = body?.error?.retry_after_ms;
      throw err;
    }
    return body; // { id, created_at }：ephemeral 模式下 id 形如 "e12"
  }

  /** 补历史：events 表只保留 1h，断线久了必须用 messages 接口回填 */
  async backfill(limit = 200) {
    const qs = new URLSearchParams({
      since: String(this.#lastMessageId),
      limit: String(limit),
    });
    const res = await fetch(`${this.base}/api/messages?${qs}`);
    if (!res.ok) return; // 存储不可用等情况：交给流本身去报错
    const { messages } = await res.json();
    for (const m of messages) this.#onMessage(m);
  }

  #onMessage(m) {
    const id = String(m.id);
    if (this.#seen.has(id)) return; // 幂等：续传会重放
    this.#seen.set(id, 1);
    if (this.#seen.size > SEEN_MAX)
      this.#seen.delete(this.#seen.keys().next().value);
    // 只有持久化消息（纯数字 id）才能推进历史游标；"e12" 是 ephemeral 直播消息
    if (/^\d+$/.test(id))
      this.#lastMessageId = Math.max(this.#lastMessageId, Number(id));
    this.#emit("message", m);
  }

  start() {
    this.#closed = false;
    this.#loop();
    return this;
  }

  async #loop() {
    while (!this.#closed) {
      let wait = RECONNECT_MS;
      try {
        await this.backfill();
        await this.#stream(); // 正常返回 = 连接被平台/网络切断
      } catch (err) {
        if (!this.#closed) this.#emit("error", err);
        if (err?.retryAfterMs) wait = Math.max(wait, err.retryAfterMs);
      }
      if (!this.#closed) await new Promise((r) => setTimeout(r, wait));
    }
  }

  async #stream() {
    this.#ac = new AbortController();
    const qs = new URLSearchParams({
      since: String(this.#since),
      client_id: this.clientId,
    });
    const res = await fetch(`${this.base}/api/stream?${qs}`, {
      headers: { accept: "text/event-stream" },
      signal: this.#ac.signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => null);
      const err = new Error(body?.error?.message ?? `stream HTTP ${res.status}`);
      err.code = body?.error?.code;
      err.retryAfterMs = body?.error?.retry_after_ms;
      throw err;
    }
    this.#lastFrame = Date.now();
    const watchdog = setInterval(() => {
      // 服务端每 15s 至少发一次 ": ping"，长时间静默说明链路已死
      if (Date.now() - this.#lastFrame > IDLE_MS) this.#ac.abort();
    }, 5_000);
    try {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.#lastFrame = Date.now();
        buf += dec.decode(value, { stream: true });
        let i = buf.indexOf("\n\n");
        while (i >= 0) {
          this.#frame(buf.slice(0, i));
          buf = buf.slice(i + 2);
          i = buf.indexOf("\n\n");
        }
      }
    } finally {
      clearInterval(watchdog);
    }
  }

  /** 解析一个 SSE 帧：event 名 + data 行（注释行是心跳，直接忽略） */
  #frame(raw) {
    let type = "message";
    const data = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) continue; // ": ping"
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    let payload;
    try {
      payload = JSON.parse(data.join("\n"));
    } catch {
      return; // 非 JSON 帧一律忽略
    }
    if (type === "message") return this.#onMessage(payload);
    if (type === "delete") return this.#emit("delete", payload);
    if (type === "presence") return this.#emit("presence", payload);
    if (type === "notice") return this.#emit("notice", payload);
    if (type === "ban") return this.#emit("ban", payload);
    if (type === "error") return this.#emit("error", payload);
    // 未知事件类型必须忽略：服务端新增事件类型不得让旧客户端崩
  }

  close() {
    this.#closed = true;
    this.#ac?.abort();
  }
}

// ---------------- 直接运行本文件时的演示 ----------------
/** 被 import 时不执行演示：优先用 import.meta.main（Bun / Node 24+），否则比对真实路径 */
function isDirectRun() {
  if (import.meta.main !== undefined) return import.meta.main;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const out = (line) => process.stdout.write(`${line}\n`);
  const chat = new ChatClient({});
  const hhmmss = (v) => new Date(v).toLocaleTimeString();
  chat
    .on("message", (m) => out(`[${hhmmss(m.created_at)}] ${m.nick}: ${m.text}`))
    .on("delete", (d) => out(`[系统] 消息 ${d.id} 已被删除`))
    .on("presence", (p) => out(`[在线] ${p.online} 人`))
    .on("notice", (n) =>
      out(`[通知] 历史模式 ${n.mode}（保留 ${n.retention_days} 天）`),
    )
    .on("ban", (b) => out(`[禁言] 本机已被禁言：${b.reason}`))
    .on("error", (e) => out(`[错误] ${e.message ?? JSON.stringify(e)}`))
    .start();

  out(`已连接 ${BASE}\n身份 client_id=${chat.clientId}`);
  await new Promise((r) => setTimeout(r, 1500));
  try {
    await chat.send(`来自接入示例的消息 ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    out(`发送失败：[${err.code ?? "?"}] ${err.message}`);
  }
  process.on("SIGINT", () => {
    chat.close();
    process.exit(0);
  });
}
