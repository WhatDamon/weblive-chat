#!/usr/bin/env node
/** Zero-dep example: `bun examples/client.mjs [base] [nick]`; see docs/integration.md */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.argv[2] ?? "http://localhost:3000").replace(/\/+$/, "");
const NICK = process.argv[3] ?? "example-client";
const RECONNECT_MS = 1000; // keep >= 1s or reconnects trip the stream rate limit (20/min)
const SEEN_MAX = 5000;
const IDLE_MS = 45_000;

/** Browser equivalent: localStorage */
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
  #since = 0; // SSE cursor: events.id, NOT messages.id
  #lastMessageId = 0; // history cursor: messages.id
  #seen = new Map();
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

  /** POST accepted != displayed: the message comes back over SSE, including your own */
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
    return body; // { id, created_at }; ephemeral live-only ids look like "e12"
  }

  /** Backfill: the events table is purged after ~1h, so long disconnects need this */
  async backfill(limit = 200) {
    const qs = new URLSearchParams({
      since: String(this.#lastMessageId),
      limit: String(limit),
    });
    const res = await fetch(`${this.base}/api/messages?${qs}`);
    if (!res.ok) return; // storage outages are reported by the stream instead
    const { messages } = await res.json();
    for (const m of messages) this.#onMessage(m);
  }

  #onMessage(m) {
    const id = String(m.id);
    if (this.#seen.has(id)) return; // replay after resume
    this.#seen.set(id, 1);
    if (this.#seen.size > SEEN_MAX)
      this.#seen.delete(this.#seen.keys().next().value);
    // only persisted (numeric) ids advance the history cursor
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
        await this.#stream(); // normal return = platform or network cut the stream
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
      const err = new Error(
        body?.error?.message ?? `stream HTTP ${res.status}`,
      );
      err.code = body?.error?.code;
      err.retryAfterMs = body?.error?.retry_after_ms;
      throw err;
    }
    this.#lastFrame = Date.now();
    const watchdog = setInterval(() => {
      // the server pings at least every 15s; longer silence means the link is dead
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

  #frame(raw) {
    let type = "message";
    const data = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) continue; // heartbeat
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    let payload;
    try {
      payload = JSON.parse(data.join("\n"));
    } catch {
      return;
    }
    if (type === "message") return this.#onMessage(payload);
    if (type === "delete") return this.#emit("delete", payload);
    if (type === "presence") return this.#emit("presence", payload);
    if (type === "notice") return this.#emit("notice", payload);
    if (type === "ban") return this.#emit("ban", payload);
    if (type === "error") return this.#emit("error", payload);
    // unknown event types must be ignored: new server events must not break old clients
  }

  close() {
    this.#closed = true;
    this.#ac?.abort();
  }
}

/** Skip the demo on import: import.meta.main needs Bun/Node 24+, else compare real paths */
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
    .on("delete", (d) => out(`[deleted] message ${d.id}`))
    .on("presence", (p) => out(`[online] ${p.online}`))
    .on("notice", (n) =>
      out(`[notice] history mode ${n.mode} (retention ${n.retention_days}d)`),
    )
    .on("ban", (b) => out(`[banned] this IP is muted: ${b.reason}`))
    .on("error", (e) => out(`[error] ${e.message ?? JSON.stringify(e)}`))
    .start();

  out(`connected ${BASE}\nclient_id=${chat.clientId}`);
  await new Promise((r) => setTimeout(r, 1500));
  try {
    await chat.send(
      `hello from the example client ${new Date().toLocaleTimeString()}`,
    );
  } catch (err) {
    out(`send failed: [${err.code ?? "?"}] ${err.message}`);
  }
  process.on("SIGINT", () => {
    chat.close();
    process.exit(0);
  });
}
