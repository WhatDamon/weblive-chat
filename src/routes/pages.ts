import type { Context, Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { COPY, fill, lookupCopy } from "../lib/copy";

// cwd is the repo root locally; vercel.json includeFiles ships public/** to the function.
const readPublic = async (file: string) => {
  return readFile(join(process.cwd(), "public", file), "utf8");
};

const TOKEN = /\{\{([\w.]+)\}\}/g;

/** Injects window.COPY/fill; "<" is escaped so copy containing "</script" cannot close it. */
const copyBootstrap = () =>
  `<script>window.COPY=${JSON.stringify(COPY).replace(/</g, "\\u003c")};` +
  "window.fill=function(t,v){return t.replace(/\\{(\\w+)\\}/g,function(m,k){return k in v?v[k]:m})};</script>";

/** Replaces {{a.b}} with copy.ts text and <!--COPY--> with the bootstrap script. */
export function renderPage(html: string): string {
  return html
    .replace(
      TOKEN,
      (raw, path: string) =>
        lookupCopy(path) ??
        (console.error(`[copy] undefined placeholder: ${raw}`), raw),
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
  app.get("/admin", (c) => serve(c, "admin.html"));
  app.get("/admin.html", (c) => serve(c, "admin.html"));
}
