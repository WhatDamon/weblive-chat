// End-to-end smoke: real server on a temp SQLite file, exercising the full chain.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRepo } from "../../src/lib/repo";

// Repo root derived from this file: never hardcode absolute paths.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "wl-smoke-"));
const dbPath = join(tmp, "smoke.db");
let child: ChildProcess | null = null; // Module scope: the error path must still clean up
const ADMIN_SECRET = "smoke-" + crypto.randomUUID();
const XFF_A = "9.9.9.8"; // Banned mid-run: chats first, then banned
const XFF_B = "9.9.9.9"; // Bystander: never banned

let fails = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(
    `${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  [" + extra + "]" : ""}`,
  );
  if (!cond) fails++;
};

async function json(res: Response) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function parseSseBlocks(raw: string): { type: string; data: any }[] {
  const out: { type: string; data: any }[] = [];
  for (const block of raw.split("\n\n")) {
    let type = "message";
    let data: any = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:"))
        data = JSON.parse(line.slice(5).trim());
    }
    if (data !== null) out.push({ type, data });
  }
  return out;
}

/** SIGTERM the server and wait for exit; listener attached before kill to avoid a race. */
async function stopServer(): Promise<void> {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((r) => child!.once("exit", () => r()));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  }
  await new Promise((r) => setTimeout(r, 200));
}

async function main() {
  const proc: ChildProcess = (child = spawn("bun", ["src/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: "0",
      DB_PROVIDER: "sqlite",
      DATABASE_URL: `file:${dbPath}`,
      ADMIN_SECRET,
      DB_MIGRATE_ON_BOOT: "true",
      ALLOWED_ORIGINS: "",
      REQUIRE_ORIGIN: "0",
    } as Record<string, string>,
    stdio: ["ignore", "pipe", "pipe"],
  }));
  let outBuf = "";
  void proc.stderr?.on("data", (d) => process.stderr.write("[srv-err] " + d));
  const ready = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("启动超时；stdout:\n" + outBuf)),
      20_000,
    );
    proc.stdout!.on("data", (d) => {
      outBuf += d.toString();
      const m = outBuf.match(/http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    proc.on("error", reject);
    proc.on("exit", (code, sig) => {
      if (!outBuf.includes("http://localhost:"))
        reject(
          new Error(`进程提前退出 code=${code} sig=${sig}；stdout:\n${outBuf}`),
        );
    });
  });
  const port = await ready;
  const base = `http://localhost:${port}`;
  console.log(
    `[server ready] ${base}（ADMIN_SECRET 前缀 smoke-、库 ${dbPath}）`,
  );
  const h = (xff = XFF_A) => ({
    "content-type": "application/json",
    "x-forwarded-for": xff,
  });
  let cookie = "";

  // First request triggers idempotent DDL; 200 means the server is ready.
  {
    let ok = false;
    for (let i = 0; i < 50 && !ok; i++) {
      try {
        const res = await fetch(`${base}/api/meta`, { headers: h(XFF_A) });
        ok = res.status === 200;
      } catch {
        /* Not ready yet; the loop retries. */
      }
      if (!ok) await new Promise((r) => setTimeout(r, 200));
    }
    check("meta 就绪探测 200", ok);
  }

  // /api/meta also proves that env-derived config reached the app.
  {
    const res = await fetch(`${base}/api/meta`, { headers: h(XFF_A) });
    const b = await json(res);
    check(
      "meta 200 + client_ip=9.9.9.8",
      res.status === 200 && b?.client_ip === XFF_A,
      `status=${res.status}`,
    );
    check(
      "meta limits text_max=1000 / retention_days=90",
      b?.limits?.text_max === 1000 && b?.limits?.retention_days === 90,
    );
    check("meta presence ttl_s=45", b?.presence?.ttl_s === 45);
  }

  // First frame is presence: runStream upserts and counts on connect.
  const streamAbort = new AbortController();
  const sseRes = await fetch(
    `${base}/api/stream?client_id=22222222-3333-4444-8555-666666666666`,
    {
      headers: { "x-forwarded-for": XFF_A, accept: "text/event-stream" },
      signal: streamAbort.signal,
    },
  );
  check(
    "SSE 开流 200",
    sseRes.status === 200 && sseRes.body !== null,
    `status=${sseRes.status}`,
  );
  const reader = sseRes.body!.getReader();
  const decoder = new TextDecoder();
  let sseBuf = "";
  const seen: { type: string; data: any }[] = [];

  const readUntil = async (
    want: (f: { type: string; data: any }) => boolean,
    timeoutMs: number,
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const f of seen) if (want(f)) return f;
      const { done, value } = await reader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });
      const parsed = parseSseBlocks(sseBuf);
      if (parsed.length) {
        // Drop parsed frames, keep the trailing partial frame.
        const lastIdx = sseBuf.lastIndexOf("\n\n");
        sseBuf = lastIdx >= 0 ? sseBuf.slice(lastIdx + 2) : sseBuf;
        seen.push(...parsed);
      }
      for (const f of seen) if (want(f)) return f;
    }
    return null;
  };

  const presence = await readUntil(
    (f) => f.type === "presence" && f.data.online >= 1,
    6000,
  );
  check(
    "SSE 首帧 presence online>=1",
    presence !== null,
    JSON.stringify(presence?.data),
  );

  const msgText1 = "hello-e2e-1";
  const post1 = await fetch(`${base}/api/messages`, {
    method: "POST",
    headers: h(XFF_A),
    body: JSON.stringify({
      client_id: "11111111-2222-4333-8444-555555555555",
      nick: "甲",
      text: msgText1,
    }),
  });
  const post1b = await json(post1);
  check(
    "POST 消息 201 + 数字 id",
    post1.status === 201 && /^\d+$/.test(String(post1b?.id)),
    `status=${post1.status} body=${JSON.stringify(post1b)}`,
  );
  const msgId = String(post1b.id);
  const msgEvt = await readUntil(
    (f) =>
      f.type === "message" &&
      String(f.data.id) === msgId &&
      f.data.text === msgText1,
    6000,
  );
  check(
    "SSE message 事件到达（同 id+text）",
    msgEvt !== null,
    JSON.stringify(msgEvt?.data),
  );

  {
    const res = await fetch(`${base}/api/admin/login`, {
      method: "POST",
      headers: h(XFF_A),
      body: JSON.stringify({ secret: ADMIN_SECRET }),
    });
    const setCookies =
      (res.headers as any).getSetCookie?.() ??
      (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : []);
    const sc = setCookies[0] ?? "";
    cookie = (sc.match(/wl_admin=[^;]+/) ?? [""])[0];
    check(
      "login 200 + Set-Cookie(HttpOnly; SameSite=Lax)",
      res.status === 200 && /HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc),
      `status=${res.status} sc=${sc.slice(0, 60)}`,
    );
  }

  {
    const res = await fetch(`${base}/api/admin/messages/${msgId}`, {
      method: "DELETE",
      headers: { ...h(XFF_A), cookie },
    });
    check("admin 软删 204", res.status === 204, `status=${res.status}`);
    const delEvt = await readUntil(
      (f) => f.type === "delete" && String(f.data.id) === msgId,
      6000,
    );
    check("SSE delete 事件到达", delEvt !== null, JSON.stringify(delEvt?.data));
  }

  // Mute-only: a banned IP cannot post but already-open streams keep receiving.
  {
    const res = await fetch(`${base}/api/admin/bans`, {
      method: "POST",
      headers: { ...h(XFF_A), cookie },
      body: JSON.stringify({ ip: XFF_A, reason: "e2e-ban" }),
    });
    const b = await json(res);
    check(
      "封禁 200 created:true",
      res.status === 200 && b?.created === true,
      `status=${res.status}`,
    );
  }
  {
    const res = await fetch(`${base}/api/messages`, {
      method: "POST",
      headers: h(XFF_A),
      body: JSON.stringify({
        client_id: "11111111-2222-4333-8444-555555555555",
        nick: "甲",
        text: "不应入库",
      }),
    });
    check(
      "被禁 IP 发消息 → 403 banned",
      res.status === 403,
      `status=${res.status}`,
    );
    const res2 = await fetch(`${base}/api/messages`, {
      method: "POST",
      headers: h(XFF_B),
      body: JSON.stringify({
        client_id: "33333333-4444-4555-8666-777777777777",
        nick: "乙",
        text: "旁观消息-b",
      }),
    });
    const b2 = await json(res2);
    check(
      "他 IP 发消息 201（旁观可聊）",
      res2.status === 201,
      `status=${res2.status}`,
    );
    const liveEvt = await readUntil(
      (f) => f.type === "message" && String(f.data.id) === String(b2?.id),
      6000,
    );
    check(
      "已开流（被禁 IP 的流）仍收到广播 → 可旁观",
      liveEvt !== null,
      JSON.stringify(liveEvt?.data?.text),
    );
  }

  // Client B's stream is still inside the presence TTL, so online >= 1.
  {
    const res = await fetch(`${base}/api/admin/stats`, {
      headers: { ...h(XFF_A), cookie },
    });
    const b = await json(res);
    check(
      "stats 200 + messages_total>=2",
      res.status === 200 && b?.messages_total >= 2,
      `status=${res.status} ${JSON.stringify(b)}`,
    );
    check(
      "stats history.mode=full + estimate_bytes>0",
      b?.history?.mode === "full" && b?.history?.estimate_bytes > 0,
    );
    check(
      "stats online>=1（开流客户端在窗内）",
      typeof b?.online === "number" && b?.online >= 1,
      `online=${b?.online}`,
    );
  }

  {
    const res = await fetch(`${base}/api/messages?limit=5`, {
      headers: h(XFF_A),
    });
    const b = await json(res);
    const row = b?.messages?.find((m: any) => m.id === msgId);
    check(
      "历史含 msgId 且 deleted:true / text:null",
      row?.deleted === true && row?.text === null,
      JSON.stringify(row),
    );
    check("历史模式 full 透出", b?.mode === "full");
  }

  // The shipped example client is exercised so it cannot rot away from the API.
  {
    const cli = spawn("bun", ["examples/client.mjs", base, "冒烟"], {
      cwd: ROOT,
      env: { ...process.env } as Record<string, string>,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let cliOut = "";
    cli.stdout!.on("data", (d) => (cliOut += d.toString()));
    cli.stderr!.on("data", (d) => (cliOut += d.toString()));
    const exited = new Promise<void>((r) => cli.on("exit", () => r()));
    // The client streams, posts after 1.5s and echoes via SSE; 8s is enough.
    await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 8000))]);
    if (cli.exitCode === null) cli.kill("SIGTERM");
    const lines = cliOut.split("\n").filter(Boolean);
    check(
      "示例客户端实跑：身份持久化 + 建流 + 发言回显",
      cliOut.includes("身份 client_id=") &&
        /冒烟: 来自接入示例的消息/.test(cliOut),
      lines.slice(0, 3).join(" | "),
    );
  }

  streamAbort.abort();
  await stopServer();
  {
    const repo = await createRepo("sqlite", `file:${dbPath}`);
    const st = await repo.messageStats();
    check(
      "持久化复查：消息物理行>=2（含软删占位）",
      st.total >= 2,
      `total=${st.total}`,
    );
    const evs = await repo.eventsSince(0, 100);
    check(
      "持久化复查：events 含 message/delete 事件",
      evs.some((e) => e.type === "message") &&
        evs.some((e) => e.type === "delete"),
      `events=${evs.map((e) => e.type).join(",")}`,
    );
    const ban = await repo.banGet(XFF_A);
    check(
      "持久化复查：封禁落库",
      ban !== null && ban.reason === "e2e-ban",
      JSON.stringify(ban),
    );
    await repo.close();
  }

  rmSync(tmp, { recursive: true, force: true });
  console.log(
    fails === 0 ? "\n=== E2E 全部通过 ===" : `\n=== E2E 失败 ${fails} 项 ===`,
  );
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("E2E 异常：", e);
  // Error path: kill the child and remove the temp DB.
  await stopServer().catch(() => {});
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch (err) {
    // Best-effort: cleanup must never mask the original error.
    console.error("清理临时目录失败（忽略）：", err);
  }
  process.exit(2);
});
