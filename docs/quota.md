# 前端省额度指南（Vercel Hobby · 实例时间）

面向接入本后端的**前端开发者**：不改任何 API 契约，只讲「同样的功能，怎么少烧额度」。
服务端侧已做的优化与完整账目见 `docs/design.md` §7.4；接口细节见 `docs/api.md`，完整客户端骨架见 `docs/integration.md`。

> **时效**：本文全部数字（额度表、成本折算、百分比与升档建议）均以 **2026-09-12** 核对的 Vercel 官方 [Limits](https://vercel.com/docs/limits) 与 [Pricing](https://vercel.com/pricing) 为准。平台调整套餐或额度后，请以官方页面为准，并同步更新此日期与受影响的折算。

---

## 0. 先记住三句话

1. **钱花在「连接存在」上，不是花在「消息多少」上。** 只要有在途请求（尤其一条 SSE 流），实例就按 **2 GB × 时长** 计费；请求结束、实例冻结后不计费。
2. **一个月只有 180 实例小时**（360 GB-hr ÷ 2 GB，函数内存 Hobby 固定 2 GB 不可下调）= **每天 6 小时**。一条 7×24 常连就是 720 小时，**超 4 倍**。
3. 超限的后果不是扣费，而是 **功能被暂停 30 天**。所以第一原则是「**不该连的时候别连**」，第二原则才是「连的时候少干活」。

---

## 1. 额度速查（2026-09-12 核对）

| 资源 | Hobby 额度 | 折算 |
| --- | --- | --- |
| Provisioned Memory | 360 GB-hr/月 | **180 实例小时/月 = 6 实例小时/天** |
| Active CPU | 4 CPU-hr/月 | 常连 ≈1 CPU-hr/月·连接（比内存宽约 15 倍） |
| Function Invocations | 100 万/月 | 一条 300s 常连重连 = 288 次/天 |
| Fast Data Transfer | 100 GB/月 | 流里只有极小的 `message` 帧与 `: ping`，通常用不完 |
| 函数单次时长上限 | 300s | 到点必断 → **自动重连是硬要求** |

---

## 2. 每种行为花多少（先看这张表再决定用什么通道）

| 行为 | 实例时间/小时 | 折成内存额度 |
| --- | --- | --- |
| SSE 常连 | 1 实例小时 | **2 GB-hr** |
| 30s 轮询历史（120 次请求） | 60–180 秒 | **0.03–0.1 GB-hr**（比常连省 20–60 倍） |
| 5s 轮询历史（720 次请求） | 360–1080 秒 | 0.2–0.6 GB-hr（**只省 3–10 倍，却丢掉实时性**） |
| 一次页面加载（未命中边缘缓存） | ≈0.2 秒 | ≈0.0001 GB-hr |
| 一次页面加载（边缘缓存命中） | 0 | 0 |
| 一次发消息 POST | ≈0.2 秒 | ≈0.0001 GB-hr |

两个结论：

- **一条常连跑 1 小时 ≈ 2 万次普通请求**——所以「多发几次 HTTP」几乎永远比「多连一秒」划算。
- **高频轮询（≤10s）不如直接建流**：省不下多少，还丢了实时推送与在线人数。要么常连，要么 ≥30s 轮询。

---

## 3. 必做（按收益排序）

### R1 不可见就断开流（收益最大，几乎是白拿）

后台标签页的常连是纯浪费：用户看不见，也不会读消息。

```js
let ctrl = null;
let paused = document.visibilityState === "hidden"; // 以隐藏状态打开就不建流

const release = () => { ctrl?.abort(); ctrl = null; };

document.addEventListener("visibilitychange", () => {
  paused = document.visibilityState === "hidden";
  if (paused) release();
  else resyncThenConnect();          // 回来先补缺口，再重连
});
window.addEventListener("pagehide", release); // 关闭页面 / 前进后退（bfcache）也要释放
```

> **最大的坑**：只在 `reader.read()` 循环里 `break` 不算释放——服务端那条流会继续开到 300s 上限，照样计费。必须把 `AbortController.signal` 传给 `fetch`。

### R2 可见但没人动 → 降级为 30s 轮询

「人走了但页面还在前台」比「切到后台」更常见。无鼠标/键盘/滚轮/触摸 5 分钟后断开流，改 30s 轮询；任一交互立刻恢复常连。

```js
let idle = false, lastActive = Date.now();
const IDLE_MS = 300_000, POLL_MS = 30_000;

for (const ev of ["mousemove", "mousedown", "keydown", "wheel", "scroll", "touchstart"])
  document.addEventListener(ev, () => { lastActive = Date.now(); idle = false; }, { passive: true });

setInterval(() => {
  if (paused || idle || Date.now() - lastActive < IDLE_MS) return;
  idle = true;
  release();                          // 停止常连计费，进入轮询
}, 1000);
```

循环里两个状态：`paused`（不可见，什么都不做）、`idle`（每 `POLL_MS` 拉一次 `/api/messages`）。

> **必须知道的两个代价**（都靠「重连前先补缺口」兜住）：
>
> 1. 降级期间没有 presence 心跳 → 静默 45s 后从在线人数里消失，一操作立即回来（语义上就是「离开」）。
> 2. 降级期间收不到 `delete` / `notice` 实时事件 → 恢复时**先** `GET /api/messages`（含软删占位）补一次，**再**重连流。
>
> 完整循环写法见 `docs/integration.md` §9.1。

### R3 同一时刻只允许一条流

重复建流是最贵的 bug：每条都是一份 2 GB-hr/小时。

```js
async function connectLoop() {
  while (true) {
    if (paused) { await sleep(1000); continue; }
    if (idle)   { await sleep(POLL_MS); if (!paused && idle) await backfill(); continue; }
    release();                        // 建新流之前，先确认旧流已释放
    ctrl = new AbortController();
    // ... fetch(stream, { signal: ctrl.signal }) ...
  }
}
```

### R4 SPA：组件卸载、路由切换必须释放

```js
useEffect(() => {
  const ctrl = new AbortController();
  startStream(ctrl.signal);           // 流生命周期 = 组件生命周期
  return () => ctrl.abort();
}, [roomId]);                         // 依赖变化 = 旧流必须死
```

> React 18 开发模式（StrictMode）会双挂载组件——正好用来验证你的 cleanup 写对了：如果开发时看到两条流，生产环境的路由切换就会漏流。

### R5 重连要退避，别做重连风暴

服务端对开流本身有 IP 限流（默认 20 次/分），断网、被限流时若立即重连，实例时间与调用数会一起暴涨。

```js
let backoff = 1000;
try {
  // 打开流并读事件……
  backoff = 1000;                                     // 成功连上即重置
} catch { /* 断流 */ }
// 429 会带 retry_after_ms，优先听它的
const wait = Math.min(err?.error?.retry_after_ms ?? backoff, 30_000);
backoff = Math.min(backoff * 2, 30_000);
await sleep(wait);
```

### R6 别为了「在线人数」而常连

在线人数只能从 SSE 的 `presence` 事件拿到（`/api/admin/stats` 要管理员会话）。如果你只需要一个数字、不需要实时消息，用一条常连去换它是**不划算**的：把这类页面改成「低频轮询历史 + 用户有交互后再建流」。

---

## 4. 加分项

### R7 多标签页共享一条流（BroadcastChannel 选主）

若你**故意不按可见性断流**（例如希望后台标签页也维持在线），不要让每个标签页各开一条流——选一个「主标签页」建流，把事件广播给其余标签页：

```js
const bc = new BroadcastChannel("wl");
let leader = false;

function elect() {
  // 用 localStorage 抢占 + 心跳续期，抢到的标签页建流，其余只监听
  const now = Date.now();
  const holder = JSON.parse(localStorage.getItem("wl.leader") || "null");
  if (!holder || now - holder.at > 10_000) {
    localStorage.setItem("wl.leader", JSON.stringify({ id: tabId, at: now }));
  }
  leader = JSON.parse(localStorage.getItem("wl.leader")).id === tabId;
}

bc.onmessage = (e) => { if (e.data.kind === "event") applyEvent(e.data.payload); };
// 主标签页每收到一个 SSE 事件： bc.postMessage({ kind: "event", payload })
```

> 更简单的做法通常是直接采用 R1：不可见的标签页本来就不需要流。

### R8 不要轮询 `/api/meta`

它返回的是**请求无关的静态配置**（限额、presence TTL、在线人数上限等）。页面加载时取一次、缓存到内存即可；一次性读取的代价与反复轮询差几十倍。

### R9 发完消息不要立刻再拉一次历史

`POST /api/messages` 成功后，你自己发的那条消息会**从 SSE 回显**（`message` 事件，含自己的消息）。按 `id` 去重渲染即可，不必再 `GET /api/messages`——省一次请求，也避免顺序错乱导致重复。

> 去重**只能按 `id`**：历史接口的 `created_at` 是 ISO 字符串、SSE 载荷里是 epoch 毫秒数字，两者不可直接比较。`ephemeral` 降级模式下 id 形如 `"e<eventId>"`，且不可回溯。

### R10 只用你真正需要的通道

| 场景 | 建议 | 量级 |
| --- | --- | --- |
| 聊天室主界面（要实时推送 + 在线人数） | SSE 常连 + R1/R2 | 2 GB-hr/小时（仅「可见且活跃」时） |
| 侧边栏挂件、通知角标、低频更新的页面 | 30s 轮询 `/api/messages?since=` | 0.03–0.1 GB-hr/小时 |
| 几十人常显大屏 | 轮询，或升 Pro / 换外部总线 | 见 §5 |

---

## 5. 反模式 → 正确做法

| 反模式 | 为什么会贵 | 改成 |
| --- | --- | --- |
| 后台标签页保持常连 | 2 GB-hr/小时白烧，一夜 8 小时 = 16 GB-hr（全月额度 4.4%） | R1 |
| 每个标签页各开一条流 | N 倍成本 | R1、R7 |
| 前台放一整夜不关 | 12 小时 = 24 GB-hr（全月 6.7%），连续两周就超限 | R2 |
| SPA 路由切换不 abort | 每条残留流都在计费，一天能攒出几十条 | R3、R4 |
| `onerror` 里立即重连 | 断网/限流时重连风暴，实例时间与调用数一起爆 | R5 |
| 5s 轮询历史 | 只比常连省 3–10 倍，还丢掉实时性 | 常连或 ≥30s 轮询 |
| 用流只为拿在线人数 | 用 2 GB-hr/小时换一个数字 | R6 |
| 发消息后再拉一次历史 | 每条消息多一次请求 + 可能重复渲染 | R9 |
| 轮询 `/api/meta` | 静态配置被反复拉取 | R8 |
| 用 `setInterval` 定时重建流 | 与断线重连叠加 → 多条流并存 | R3、R5 |

---

## 6. 怎么确认自己省下来了

**埋点换算**（一行公式）：`GB-hr = 累计流打开秒数 × 2 ÷ 3600`。

```js
let streamSeconds = 0, openedAt = 0;
// 开流成功后： openedAt = Date.now()
// 释放流时：   streamSeconds += (Date.now() - openedAt) / 1000
// 页面卸载前上报： navigator.sendBeacon("/你的埋点", String(streamSeconds))
```

对照一下是否合理：

| 你的用法 | 月度内存额度（10 个用户） |
| --- | --- |
| 每人每天「可见且活跃」10 分钟 | 10 × 10 × 30 ÷ 60 × 2 = **100 GB-hr**（占 28%） |
| 每人每天「可见且活跃」30 分钟 | **300 GB-hr**（占 83%，不建议） |
| 每人每天后台常挂 8 小时 | **4800 GB-hr**（超限 13 倍 → 功能停 30 天） |

另外：Vercel 控制台 **Usage → Provisioned Memory** 曲线里的每一段上升沿，对应的就是你的常连；本地自测时把内置页阈值调小即可复现降级行为（`window.WL = { idleMs: 5000, pollMs: 5000 }`）。

---

## 7. 什么时候不该用 SSE

- **在线人数是硬需求、用户量又大**：人数只能随流下发。若必须「后台也在线」，考虑 R7 选主共享，或把实时通道换成外部总线（Ably/Pusher 免费档），DB 只留历史——契约不变，见 `docs/design.md` §7.3。
- **几十个常显页面**：直接轮询，或升 Pro。升 Pro 后**记得把函数内存设小**（例如 512 MB）：同样一条常连从 2 GB-hr/小时降到 0.5 GB-hr/小时，等于额度翻 4 倍。
- **只是偶尔看新消息**：30s 轮询比常连省 20–60 倍，代价是放弃推送与 presence。

> 一句话总结：**让流的生命周期等于「用户真正在看这个页面且会读新消息」的时间**，其余时间用历史接口补齐。做到这一点，180 实例小时够一个小圈子用很久。
