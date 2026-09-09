import type { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// 本地/测试 cwd 为仓库根；Vercel 由 vercel.json includeFiles 把 public/** 打进函数工作目录（T9）
const readPublic = async (file: string) => {
  return readFile(join(process.cwd(), "public", file), "utf8");
};

const serve = async (c: import("hono").Context, file: string, label: string) => {
  try {
    return c.html(await readPublic(file));
  } catch {
    return c.body(`${label} 缺失`, 404);
  }
};

export function registerPages(app: Hono) {
  app.get("/", (c) => c.redirect("/demo.html", 302));
  app.get("/demo.html", (c) => serve(c, "demo.html", "demo 页"));
  // /admin 与 /admin.html 同文件直服（测试契约：两地址均 200；零构建静态页无重定向必要）
  app.get("/admin", (c) => serve(c, "admin.html", "admin 页"));
  app.get("/admin.html", (c) => serve(c, "admin.html", "admin 页"));
}
