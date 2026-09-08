// T9/T10 本地端到端验收（真实打包入口：spawn `bun src/index.ts`，真实 file: sqlite 临时库）
// 跨功能链：meta → SSE 开流(presence) → POST 消息(message 事件) → admin login →
// 软删(delete 事件) → 封禁(禁言不禁看：被禁 IP 403、他 IP 消息仍广播到已开流) → stats → 历史视图 → 持久化复查
// 运行：bun tests/e2e/e2e-acceptance.ts（仓库根由脚本位置相对推导，不依赖调用时 cwd）
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRepo } from "../../src/lib/repo";

// 仓库根 = 本文件上溯两级（tests/e2e/ → repo 根）；勿硬编码绝对路径
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "wl-e2e-"));
const dbPath = join(tmp, "e2e.db");
let child: ChildProcess | null = null; // 模块级：异常路径也须杀子进程 + 清理临时库
const ADMIN_SECRET = "e2e-" + Math.random().toString(36).slice(2);
const XFF_A = "9.9.9.8"; // 被禁 IP（先聊后封）
const XFF_B = "9.9.9.9"; // 旁观看客（始终可聊）

let fails = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  [" + extra + "]" : ""}`);
  if (!cond) fails++;
};

async function json(res: Response) {
  try { return await res.json(); } catch { return null; }
}

function parseSseBlocks(raw: string): { type: string; data: any }[] {
  const out: { type: string; data: any }[] = [];
  for (const block of raw.split("\n\n")) {
    let type = "message";
    let data: any = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data = JSON.parse(line.slice(5).trim());
    }
    if (data !== null) out.push({ type, data });
  }
  return out;
}

/** SIGTERM 停服并等待退出（先挂监听再 kill，防竞态；最多等 3s） */
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
    const timer = setTimeout(() => reject(new Error("启动超时；stdout:\n" + outBuf)), 20_000);
    proc.stdout!.on("data", (d) => {
      outBuf += d.toString();
      const m = outBuf.match(/http:\/\/localhost:(\d+)\/demo\.html/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    proc.on("error", reject);
    proc.on("exit", (code, sig) => {
      if (!outBuf.includes("/demo.html"))
        reject(new Error(`进程提前退出 code=${code} sig=${sig}；stdout:\n${outBuf}`));
    });
  });
  const port = await ready;
  const base = `http://localhost:${port}`;
  console.log(`[dev server up] ${base}（ADMIN_SECRET 前缀 e2e-、库 ${dbPath}）`);
  const h = (xff = XFF_A) => ({ "content-type": "application/json", "x-forwarded-for": xff });
  let cookie = "";

  // 0. 就绪探测：首个请求触发幂等建表，meta 200 即认为服务可用（日志匹配外的显式门）
  {
    let ok = false;
    for (let i = 0; i < 50 && !ok; i++) {
      try {
        const res = await fetch(`${base}/api/meta`, { headers: h(XFF_A) });
        ok = res.status === 200;
      } catch { /* 未就绪，重试 */ }
      if (!ok) await new Promise((r) => setTimeout(r, 200));
    }
    check("meta 就绪探测 200", ok);
  }

  // 1. meta（无 DB 写依赖的启动探针 + cfg 经 env 生效证据）
  {
    const res = await fetch(`${base}/api/meta`, { headers: h(XFF_A) });
    const b = await json(res);
    check("meta 200 + client_ip=9.9.9.8", res.status === 200 && b?.client_ip === XFF_A, `status=${res.status}`);
    check("meta limits text_max=1000 / retention_days=90", b?.limits?.text_max === 1000 && b?.limits?.retention_days === 90);
    check("meta presence ttl_s=45", b?.presence?.ttl_s === 45);
  }

  // 2. 开流（client B）→ 首帧 presence（runStream 连接即初始 upsert+count）
  const streamAbort = new AbortController();
  const sseRes = await fetch(`${base}/api/stream?client_id=22222222-3333-4444-8555-666666666666`, {
    headers: { "x-forwarded-for": XFF_A, accept: "text/event-stream" },
    signal: streamAbort.signal,
  });
  check("SSE 开流 200", sseRes.status === 200 && sseRes.body !== null, `status=${sseRes.status}`);
  const reader = sseRes.body!.getReader();
  const decoder = new TextDecoder();
  let sseBuf = "";
  const seen: { type: string; data: any }[] = [];

  const readUntil = async (want: (f: { type: string; data: any }) => boolean, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const f of seen) if (want(f)) return f;
      const { done, value } = await reader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });
      const parsed = parseSseBlocks(sseBuf);
      if (parsed.length) {
        // 已解析即从缓冲移除（保留残余半帧）
        const lastIdx = sseBuf.lastIndexOf("\n\n");
        sseBuf = lastIdx >= 0 ? sseBuf.slice(lastIdx + 2) : sseBuf;
        seen.push(...parsed);
      }
      for (const f of seen) if (want(f)) return f;
    }
    return null;
  };

  const presence = await readUntil((f) => f.type === "presence" && f.data.online >= 1, 6000);
  check("SSE 首帧 presence online>=1", presence !== null, JSON.stringify(presence?.data));

  // 3. POST 消息 → SSE 收到 message 事件（id 一致、text 一致）
  const msgText1 = "hello-e2e-1";
  const post1 = await fetch(`${base}/api/messages`, {
    method: "POST", headers: h(XFF_A),
    body: JSON.stringify({ client_id: "11111111-2222-4333-8444-555555555555", nick: "甲", text: msgText1 }),
  });
  const post1b = await json(post1);
  check("POST 消息 201 + 数字 id", post1.status === 201 && /^\d+$/.test(String(post1b?.id)), `status=${post1.status} body=${JSON.stringify(post1b)}`);
  const msgId = String(post1b.id);
  const msgEvt = await readUntil((f) => f.type === "message" && String(f.data.id) === msgId && f.data.text === msgText1, 6000);
  check("SSE message 事件到达（同 id+text）", msgEvt !== null, JSON.stringify(msgEvt?.data));

  // 4. admin login → cookie
  {
    const res = await fetch(`${base}/api/admin/login`, {
      method: "POST", headers: h(XFF_A),
      body: JSON.stringify({ secret: ADMIN_SECRET }),
    });
    const setCookies = (res.headers as any).getSetCookie?.() ?? (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : []);
    const sc = setCookies[0] ?? "";
    cookie = (sc.match(/wl_admin=[^;]+/) ?? [""])[0];
    check("login 200 + Set-Cookie(HttpOnly; SameSite=Lax)", res.status === 200 && /HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc), `status=${res.status} sc=${sc.slice(0, 60)}`);
  }

  // 5. 软删 → SSE delete 事件
  {
    const res = await fetch(`${base}/api/admin/messages/${msgId}`, {
      method: "DELETE", headers: { ...h(XFF_A), cookie },
    });
    check("admin 软删 204", res.status === 204, `status=${res.status}`);
    const delEvt = await readUntil((f) => f.type === "delete" && String(f.data.id) === msgId, 6000);
    check("SSE delete 事件到达", delEvt !== null, JSON.stringify(delEvt?.data));
  }

  // 6. 封禁 XFF_A（禁言不禁看 D5）
  {
    const res = await fetch(`${base}/api/admin/bans`, {
      method: "POST", headers: { ...h(XFF_A), cookie },
      body: JSON.stringify({ ip: XFF_A, reason: "e2e-ban" }),
    });
    const b = await json(res);
    check("封禁 200 created:true", res.status === 200 && b?.created === true, `status=${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/messages`, {
      method: "POST", headers: h(XFF_A),
      body: JSON.stringify({ client_id: "11111111-2222-4333-8444-555555555555", nick: "甲", text: "不应入库" }),
    });
    check("被禁 IP 发消息 → 403 banned", res.status === 403, `status=${res.status}`);
    const res2 = await fetch(`${base}/api/messages`, {
      method: "POST", headers: h(XFF_B),
      body: JSON.stringify({ client_id: "33333333-4444-4555-8666-777777777777", nick: "乙", text: "旁观消息-b" }),
    });
    const b2 = await json(res2);
    check("他 IP 发消息 201（旁观可聊）", res2.status === 201, `status=${res2.status}`);
    const liveEvt = await readUntil((f) => f.type === "message" && String(f.data.id) === String(b2?.id), 6000);
    check("已开流（被禁 IP 的流）仍收到广播 → 可旁观", liveEvt !== null, JSON.stringify(liveEvt?.data?.text));
  }

  // 7. stats（含 mode full / total / estimate_bytes；SSE 客户端 B 仍在窗内 → online>=1）
  {
    const res = await fetch(`${base}/api/admin/stats`, { headers: { ...h(XFF_A), cookie } });
    const b = await json(res);
    check("stats 200 + messages_total>=2", res.status === 200 && b?.messages_total >= 2, `status=${res.status} ${JSON.stringify(b)}`);
    check("stats history.mode=full + estimate_bytes>0", b?.history?.mode === "full" && b?.history?.estimate_bytes > 0);
    check("stats online>=1（开流客户端在窗内）", typeof b?.online === "number" && b?.online >= 1, `online=${b?.online}`);
  }

  // 8. 历史视图：msgId 已软删（deleted:true, text:null）
  {
    const res = await fetch(`${base}/api/messages?limit=5`, { headers: h(XFF_A) });
    const b = await json(res);
    const row = b?.messages?.find((m: any) => m.id === msgId);
    check("历史含 msgId 且 deleted:true / text:null", row?.deleted === true && row?.text === null, JSON.stringify(row));
    check("历史模式 full 透出", b?.mode === "full");
  }

  // 9. 收尾：关流、停服、持久化复查
  streamAbort.abort();
  await stopServer();
  {
    const repo = await createRepo("sqlite", `file:${dbPath}`);
    const st = await repo.messageStats();
    check("持久化复查：消息物理行>=2（含软删占位）", st.total >= 2, `total=${st.total}`);
    const evs = await repo.eventsSince(0, 100);
    check("持久化复查：events 含 message/delete 事件", evs.some((e) => e.type === "message") && evs.some((e) => e.type === "delete"), `events=${evs.map((e) => e.type).join(",")}`);
    const ban = await repo.banGet(XFF_A);
    check("持久化复查：封禁落库", ban !== null && ban.reason === "e2e-ban", JSON.stringify(ban));
    await repo.close();
  }

  rmSync(tmp, { recursive: true, force: true });
  console.log(fails === 0 ? "\n=== E2E 全部通过 ===" : `\n=== E2E 失败 ${fails} 项 ===`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("E2E 异常：", e);
  // 异常路径：杀子进程 + 清理临时库（防孤儿进程 / /tmp 泄漏）
  await stopServer().catch(() => {});
  try { rmSync(tmp, { recursive: true, force: true }); } catch (err) {
    // best-effort：临时目录清理失败（如文件被占用）不掩盖原始错误，仅记录
    console.error("清理临时目录失败（忽略）：", err);
  }
  process.exit(2);
});
