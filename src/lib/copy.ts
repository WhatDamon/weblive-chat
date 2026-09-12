// Single source of every user-visible string: API errors + both built-in pages.
// Injected at render time; keep "{n}" placeholders, and keys are referenced by pages/tests.
export const COPY = {
  // Keys must match ErrCode in src/lib/http.ts (enforced by the compiler).
  error: {
    invalid_body: "请求体缺失或不是 JSON",
    invalid_uuid: "client_id 必须是合法 UUID",
    invalid_cursor: "游标 id 必须是正整数",
    nick_empty: "昵称不能为空",
    nick_too_long: "昵称过长",
    text_empty: "内容不能为空",
    text_too_long: "内容过长",
    banned_word: "内容含违禁词",
    banned: "该 IP 已被禁言",
    rate_limited: "请求过于频繁",
    origin_not_allowed: "来源不被允许",
    missing_origin: "请求缺少 Origin",
    unauthorized: "未登录或会话失效",
    invalid_secret: "管理口令错误",
    invalid_confirm: "确认短语不匹配",
    invalid_token: "预检已失效，请重新预检",
    not_found: "资源不存在",
    db_unavailable: "数据库暂不可用",
  },

  // Route-level messages that replace the default error text.
  route: {
    limitOffsetInt: "limit/offset 必须是整数",
    ipInvalid: "ip 不合法",
    scopeInvalid: "scope 必须是 chat 或 full",
    confirmPhraseMismatch: "确认短语需逐字输入「{phrase}」",
    tokenUsed: "该预检已失效，请重新预检",
    beforeSinceConflict: "before 与 since 不可同时使用",
    limitPositiveInt: "limit 必须是正整数",
    banReasonBlank: "（未填写原因）",
    pageMissing: "页面文件缺失：{file}",
  },

  // Danger-zone copy: typed confirmation phrases and scope descriptions.
  purge: {
    phraseChat: "清空聊天记录",
    phraseFull: "清空全部数据",
    descChat: "聊天记录（消息与事件），保留封禁名单、在线状态与限流计数",
    descFull:
      "全部数据（消息、事件、在线状态、限流计数、封禁名单），相当于恢复出厂",
    tokenInvalid: "预检已失效，请重新预检",
    tokenScope: "预检范围已变更，请重新预检",
    tokenIp: "预检与本机 IP 不一致，请重新预检",
  },

  // /admin page copy ({{admin.*}} placeholders and window.COPY.admin.*).
  admin: {
    title: "WebLive Chat · 管理后台",
    heading: "WebLive Chat 管理后台",
    back: "← 返回聊天室",

    loginTitle: "管理员登录",
    loginBtn: "登录",
    secretPlaceholder: "管理员口令",

    statsTitle: "运行状态",
    statsBtn: "刷新状态",
    statsLineOnline: "在线人数：{n}",
    statsLineMessages: "消息总数：{n}",
    statsLineHistory: "历史保留：{value}",
    statsLineStorage: "存储占用：{mb} MB",
    statsRefreshedAt: "刷新于 {time}",
    statsFailed: "读取失败：{msg}",
    historyDays: "{n} 天",
    historyDegraded: "（已自动缩短）",
    historyEphemeral: "仅实时，不保存历史",

    banTitle: "IP 封禁",
    banHint: "被封禁的 IP 无法发言，仍可观看。",
    banBtn: "封禁",
    banSelfBtn: "封禁本机",
    banIpPlaceholder: "IP，如 1.2.3.4",
    banReasonPlaceholder: "原因（可选）",
    banNeedIp: "请填写 IP",
    banSelfNoIp: "未获取到本机 IP，请通过部署域名访问本页。",
    banSelfReason: "管理页自助封禁",
    banUnban: "解封",
    banNone: "暂无封禁",
    banLine: "{ip}（{reason}）— {time}",
    banLineNoReason: "{ip} — {time}",
    selfIpLine: "本机 IP：{ip}",
    ipUnknown: "未知",

    msgTitle: "最近消息",
    msgHint: "删除后立即对所有访客生效。",
    msgBtn: "刷新消息",
    msgNone: "暂无消息",
    msgEphemeral: "仅实时模式，不保存历史",
    msgDeleted: "（已删除）",
    msgDelete: "删除",
    msgAuthor: "{nick}：",

    purgeTitle: "⚠ 清空数据",
    purgeHint: "此操作不可撤销，将永久删除所选范围内的数据。",
    purgeScopeChat: "聊天记录",
    purgeScopeFull: "全部数据（含封禁名单）",
    purgePreviewBtn: "预检",
    purgePhraseLabel: "确认短语：",
    purgeGoBtn: "确认清空",
    purgeFooter: "清空后，已打开的页面需刷新才会更新。",
    purgeConfirmPlaceholder: "确认短语",
    purgeNeedPreview: "请先预检",
    purgePhraseWrong: "确认短语不匹配，请输入：{phrase}",
    purgeNeedSecret: "请输入管理员口令以确认",
    purgeLabelFull: "全部数据",
    purgeLabelChat: "聊天记录",
    purgeConfirmDialog: "即将清空「{label}」，此操作不可撤销。确定继续？",
    purgeSummary: "将删除：{del}。保留：{keep}。",
    purgeKeepNone: "无",
    purgeWait: "{n} 秒后可确认",
    purgeTokenLeft: "{n} 秒后需重新预检",
    purgeExpired: "预检已过期，请重新预检",
    purgeSwitched: "已切换范围，请重新预检",
    purgeDone: "已清空：{detail}",
    purgeNothing: "无数据",

    tableMessages: "消息",
    tableEvents: "事件",
    tablePresence: "在线状态",
    tableRateLimits: "限流计数",
    tableBans: "封禁名单",
    tableItem: "{label} {n}",
    tableJoin: "、",

    originDenied:
      "当前域名未获得接口访问许可。\n请在部署环境变量 ALLOWED_ORIGINS 中加入 {origin}（留空表示不限制），然后重新部署。",
    originRequired:
      "服务器要求请求携带 Origin。\n请通过部署域名访问本页，或去掉 REQUIRE_ORIGIN 限制。",
    actionFailed: "操作失败：{msg}",
  },

  // /demo.html chat page copy ({{chat.*}} placeholders and window.COPY.chat.*).
  chat: {
    title: "WebLive Chat · 实时聊天",
    heading: "WebLive Chat",
    onlinePrefix: "在线",
    onlineSuffix: "人",
    ipLabel: "本机 IP：",
    adminLink: "管理后台",
    ipUnknown: "未知",

    statusConnecting: "连接中…",
    statusConnected: "已连接",
    statusReconnecting: "重连中…",
    statusConnectFailed: "连接失败：{msg}",
    statusBanned: "已被禁言",
    statusOriginDenied: "当前域名不可用",
    statusForbidden: "发送被拒",
    statusTooFast: "发送过于频繁",

    nickPlaceholder: "昵称（Enter 发送）",
    textPlaceholder: "说点什么…",
    sendBtn: "发送",
    defaultNick: "路人",

    helpSummary: "使用说明",
    help1: "无需注册，昵称保存在本机；同一浏览器多开标签按一人计。",
    help2: "消息与在线人数实时推送，断线后自动重连。",
    help3: "被封禁后无法发言，仍可观看；管理员可在管理后台处理消息与封禁。",

    noteLoading: "加载历史…",
    noteEphemeral: "仅实时模式，不保存历史",
    noteEmpty: "还没有消息",
    msgDeleted: "（已删除）",
    msgAuthor: "{nick}：",
    sendFailed: "{status} 发送失败",
    sendNetworkError: "网络异常，发送失败",
    banNotice: "你已被管理员禁言：{reason}",
    banReasonUnknown: "未说明原因",
    historyOff: "历史保存已关闭，仅保留实时消息",
    historyKept: "历史保存已调整：保留 {n} 天",
    errorNotice: "发生错误：{msg}",
  },
} as const;

/** Substitutes {name} placeholders; unknown names are left as-is. */
export function fill(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) =>
    k in vars ? String(vars[k]) : m,
  );
}

/** Resolves a dotted copy path; undefined unless it lands on a string. */
export function lookupCopy(path: string): string | undefined {
  let node: unknown = COPY;
  for (const seg of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return typeof node === "string" ? node : undefined;
}
