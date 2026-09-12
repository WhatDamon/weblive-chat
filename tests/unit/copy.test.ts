import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { COPY, fill, lookupCopy } from "../../src/lib/copy";
import { renderPage } from "../../src/routes/pages";

/** Guards that page copy lives only in src/lib/copy.ts: no CJK in pages, no dangling keys. */

const PAGES = ["admin.html", "demo.html"] as const;
const pageSource = (f: string) =>
  readFileSync(new URL(`../../public/${f}`, import.meta.url), "utf8");

/** Any CJK ideograph or CJK/fullwidth punctuation. */
const CJK_CHAR =
  /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef\u2018-\u201f\u2026\u2014]/;

describe("文案唯一来源 (src/lib/copy.ts)", () => {
  test("所有文案均非空", () => {
    const walk = (node: unknown, path: string): void => {
      if (typeof node === "string") {
        expect(node.length, `${path} 不能为空`).toBeGreaterThan(0);
        return;
      }
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, `${path}.${k}`);
      }
    };
    walk(COPY, "COPY");
  });

  test("页面文件不含任何中文（文案只能来自 copy.ts）", () => {
    for (const f of PAGES) {
      const src = pageSource(f);
      const hit = CJK_CHAR.exec(src);
      const where = hit
        ? JSON.stringify(src.slice(Math.max(0, hit.index - 30), hit.index + 30))
        : "";
      expect(`${f}${where}`, `${f} 不应含文案字符：${where}`).toBe(f);
    }
  });

  test("页面的 {{占位符}} 与 COPY.x 引用都能解析", () => {
    for (const f of PAGES) {
      const src = pageSource(f);
      for (const m of src.matchAll(/\{\{([\w.]+)\}\}/g)) {
        expect(
          typeof lookupCopy(m[1]),
          `${f} 占位符 {{${m[1]}}} 在 copy.ts 中不存在`,
        ).toBe("string");
      }
      for (const m of src.matchAll(/COPY\.([\w.]+)/g)) {
        expect(
          typeof lookupCopy(m[1]),
          `${f} 引用了不存在的 COPY.${m[1]}`,
        ).toBe("string");
      }
    }
  });

  test("renderPage 替换全部占位符并注入 window.COPY / window.fill", () => {
    for (const f of PAGES) {
      const out = renderPage(pageSource(f));
      expect(out, `${f} 渲染后仍有未替换的占位符`).not.toContain("{{");
      expect(out).toContain("window.COPY=");
      expect(out).toContain("window.fill=");
      // Injected JSON must equal copy.ts exactly: page scripts render from it.
      const injected = /window\.COPY=(\{[\s\S]*?\});window\.fill=/.exec(out);
      expect(injected, `${f} 未找到注入脚本`).not.toBeNull();
      expect(JSON.parse(injected![1])).toEqual(COPY);
      // "<" is escaped so copy containing </script cannot close the tag early.
      expect(injected![1]).not.toContain("<");
    }
  });

  test("fill 只替换已知占位符", () => {
    expect(fill("a{n}b", { n: 7 })).toBe("a7b");
    expect(fill("a{n}b{s}", { n: "x" })).toBe("axb{s}");
    expect(fill("无占位符", {})).toBe("无占位符");
  });

  test("lookupCopy 只返回文案字符串", () => {
    expect(lookupCopy("admin.loginBtn")).toBe(COPY.admin.loginBtn);
    expect(lookupCopy("admin")).toBeUndefined();
    expect(lookupCopy("nope.nope")).toBeUndefined();
  });
});
