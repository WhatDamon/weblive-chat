import type { Context, Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { COPY, fill, lookupCopy } from "../lib/copy";

// 本地运行时 cwd 为仓库根；Vercel 由 vercel.json 的 includeFiles 把 public/** 打进函数工作目录
const readPublic = async (file: string) => {
  return readFile(join(process.cwd(), "public", file), "utf8");
};

const TOKEN = /\{\{([\w.]+)\}\}/g;

/**
 * window.COPY / window.fill 注入脚本：页面脚本据此读取文案，页面里不写中文。
 * JSON 中的 "<" 转义为 \u003c，避免文案包含 "</script" 时提前结束脚本标签。
 */
const copyBootstrap = () =>
  `<script>window.COPY=${JSON.stringify(COPY).replace(/</g, "\\u003c")};` +
  "window.fill=function(t,v){return t.replace(/\\{(\\w+)\\}/g,function(m,k){return k in v?v[k]:m})};</script>";

/**
 * 渲染内置页面：{{a.b}} 占位符 → src/lib/copy.ts 的文案，<!--COPY--> → 注入脚本。
 * 未定义的占位符保留原样并记录 error（tests/unit/copy.test.ts 会在提交前拦下拼写错误）。
 */
export function renderPage(html: string): string {
  return html
    .replace(
      TOKEN,
      (raw, path: string) =>
        lookupCopy(path) ??
        (console.error(`[copy] 未定义的占位符：${raw}`), raw),
    )
    .replace("<!--COPY-->", copyBootstrap());
}

const serve = async (c: Context, file: string) => {
  try {
    return c.html(renderPage(await readPublic(file)));
  } catch {
    return c.body(fill(COPY.route.pageMissing, { file }), 404);
  }
};

export function registerPages(app: Hono) {
  app.get("/", (c) => c.redirect("/demo.html", 302));
  app.get("/demo.html", (c) => serve(c, "demo.html"));
  // /admin 与 /admin.html 直服同一文件（零构建静态页，无需重定向）
  app.get("/admin", (c) => serve(c, "admin.html"));
  app.get("/admin.html", (c) => serve(c, "admin.html"));
}
