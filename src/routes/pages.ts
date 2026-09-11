import type { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// 本地运行时 cwd 为仓库根；Vercel 由 vercel.json 的 includeFiles 把 public/** 打进函数工作目录
const readPublic = async (file: string) => {
  return readFile(join(process.cwd(), "public", file), "utf8");
};

const serve = async (
  c: import("hono").Context,
  file: string,
  label: string,
) => {
  try {
    return c.html(await readPublic(file));
  } catch {
    return c.body(`${label} 缺失`, 404);
  }
};

export function registerPages(app: Hono) {
  app.get("/", (c) => c.redirect("/demo.html", 302));
  app.get("/demo.html", (c) => serve(c, "demo.html", "demo 页"));
  // /admin 与 /admin.html 直服同一文件（零构建静态页，无需重定向）
  app.get("/admin", (c) => serve(c, "admin.html", "admin 页"));
  app.get("/admin.html", (c) => serve(c, "admin.html", "admin 页"));
}
