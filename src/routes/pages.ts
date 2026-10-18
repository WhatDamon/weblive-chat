import type { Context, Hono } from "hono";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { COPY, fill, lookupCopy } from "../lib/copy";
import type { AppEnv } from "../lib/http";

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

// Pages are static per deployment: let the edge serve repeats so page loads cost no instance time.
const PAGE_CACHE = "public, s-maxage=300, stale-while-revalidate=600";

type Rendered = { html: string; csp: string };
// Per-instance memo: rendering is pure, so a cold instance pays it once per file.
const cache = new Map<string, Rendered>();
const stats = { hits: 0, misses: 0 };

/** Inline block bodies → 'sha256-…'; zero-build pages pass CSP by hash, never unsafe-inline. */
const inlineHashes = (html: string, tag: "script" | "style"): string[] =>
  [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map(
    (m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`,
  );

export function cspFor(html: string): string {
  const script = inlineHashes(html, "script");
  const style = inlineHashes(html, "style");
  return [
    "default-src 'self'",
    ["script-src 'self'", ...script].join(" "),
    ["style-src 'self'", ...style].join(" "),
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function clearPageCache(): void {
  cache.clear();
  stats.hits = 0;
  stats.misses = 0;
}

export function pageCacheStats(): { hits: number; misses: number } {
  return { ...stats };
}

const serve = async (c: Context<AppEnv>, file: string) => {
  c.header("cache-control", PAGE_CACHE);
  try {
    let r = cache.get(file);
    if (r) stats.hits += 1;
    else {
      stats.misses += 1;
      const html = renderPage(await readPublic(file));
      r = { html, csp: cspFor(html) };
      cache.set(file, r);
    }
    c.header("content-security-policy", r.csp);
    return c.html(r.html);
  } catch {
    return c.body(fill(COPY.route.pageMissing, { file }), 404);
  }
};

export function registerPages(app: Hono<AppEnv>) {
  app.get("/", (c) => {
    c.header("cache-control", PAGE_CACHE);
    return c.redirect("/demo.html", 302);
  });
  app.get("/demo.html", (c) => serve(c, "demo.html"));
  app.get("/admin", (c) => serve(c, "admin.html"));
  app.get("/admin.html", (c) => serve(c, "admin.html"));
}
