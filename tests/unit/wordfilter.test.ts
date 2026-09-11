import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWordFilter,
  loadWordFilter,
  normalizeText,
} from "../../src/lib/wordfilter";

describe("normalizeText", () => {
  test("全角转半角、英文小写化", () => {
    expect(normalizeText("ＳＰＡＭ")).toBe("spam");
    expect(normalizeText("AbC")).toBe("abc");
  });
  test("剔除零宽字符、空白、标点与符号（含全角空格）", () => {
    expect(normalizeText("赌\u200b博")).toBe("赌博");
    expect(normalizeText("赌 博")).toBe("赌博");
    expect(normalizeText("赌　博")).toBe("赌博");
    expect(normalizeText("赌*博。")).toBe("赌博");
    expect(normalizeText("hello, world!")).toBe("helloworld");
  });
  test("保留汉字、拉丁字母与数字", () => {
    expect(normalizeText("加微信abc123")).toBe("加微信abc123");
    expect(normalizeText("")).toBe("");
  });
});

describe("buildWordFilter", () => {
  test("子串命中并返回命中的词（归一化口径）", () => {
    const f = buildWordFilter(["赌博", "spam"]);
    expect(f.scan("今晚去赌博吗")).toBe("赌博");
    expect(f.scan("买 SPAM 罐头")).toBe("spam");
    expect(f.scan("正常内容")).toBe(null);
    expect(f.size).toBe(2);
  });
  test("全角、空格、零宽字符、标点插空等绕过手段仍命中", () => {
    const f = buildWordFilter(["赌博"]);
    for (const t of ["赌　博", "赌 博", "赌\u200b博", "赌*博", "赌。博"])
      expect(f.scan(t)).toBe("赌博");
  });
  test("词长下限默认 2：单字词不生效，显式放宽后生效", () => {
    expect(buildWordFilter(["屌"]).scan("屌")).toBe(null);
    expect(buildWordFilter(["屌"], [], 1).scan("屌")).toBe("屌");
  });
  test("白名单覆盖的命中区间被豁免", () => {
    const f = buildWordFilter(["赌博"], ["赌博合法"]);
    expect(f.scan("讨论赌博合法化")).toBe(null);
    expect(f.scan("今晚去赌博")).toBe("赌博");
  });
  test("词表条目自带空格/标点时按归一化形式命中连续文本", () => {
    const f = buildWordFilter(["出售炸药 电话"]);
    expect(f.scan("出售炸药电话")).toBe("出售炸药电话");
    expect(f.scan("出售炸药，电话联系")).toBe("出售炸药电话");
  });
  test("空词表与空文本安全返回 null", () => {
    expect(buildWordFilter([]).scan("任意内容")).toBe(null);
    expect(buildWordFilter(["赌博"]).scan("")).toBe(null);
  });
});

describe("loadWordFilter", () => {
  const dir = mkdtempSync(join(tmpdir(), "wl-words-"));
  const opts = { dir, extra: ["环境禁词"], allow: [] as string[] };

  // 词库文件必须在用例执行前就位，故用 beforeAll（describe 体内同步代码会在收集期就执行）
  beforeAll(() => {
    mkdirSync(join(dir, "basic"));
    mkdirSync(join(dir, "strict"));
    writeFileSync(
      join(dir, "basic", "a.txt"),
      "# 注释行忽略\n\n  测试禁词  \r\n",
    );
    writeFileSync(join(dir, "strict", "b.txt"), "严格禁词\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("basic 只加载 basic 目录，strict 目录不生效", async () => {
    const f = await loadWordFilter({ ...opts, mode: "basic" });
    expect(f.scan("这里有测试禁词")).toBe("测试禁词");
    expect(f.scan("这里有环境禁词")).toBe("环境禁词");
    expect(f.scan("这里有严格禁词")).toBe(null);
  });
  test("strict 追加加载 strict 目录", async () => {
    const f = await loadWordFilter({ ...opts, mode: "strict" });
    expect(f.scan("这里有测试禁词")).toBe("测试禁词");
    expect(f.scan("这里有严格禁词")).toBe("严格禁词");
  });
  test("off 不加载任何词库，但显式词仍生效", async () => {
    const f = await loadWordFilter({ ...opts, mode: "off" });
    expect(f.scan("这里有测试禁词")).toBe(null);
    expect(f.scan("这里有环境禁词")).toBe("环境禁词");
  });
  test("目录不存在时不抛错，仍应用显式词", async () => {
    const f = await loadWordFilter({
      ...opts,
      dir: join(dir, "缺失目录"),
      mode: "basic",
    });
    expect(f.scan("这里有环境禁词")).toBe("环境禁词");
    expect(f.scan("这里有测试禁词")).toBe(null);
  });
});
