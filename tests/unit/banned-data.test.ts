import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadWordFilter } from "../../src/lib/wordfilter";

// 数据回归护栏：护的是 data/banned/basic 这份随包分发的词库本身
// （有人手改词表时，既能挡住「词条失效」，也能挡住「常用词混入造成误伤」）
const DIR = fileURLToPath(new URL("../../data/banned", import.meta.url));

describe("内置精选词库", () => {
  const load = () => loadWordFilter({ mode: "basic", dir: DIR });

  test("命中已知违禁词，且插空/全角绕过无效", async () => {
    const f = await load();
    expect(f.size).toBeGreaterThan(500);
    expect(f.scan("出售冰毒找我")).not.toBe(null);
    expect(f.scan("出 售 冰 毒")).not.toBe(null);
    expect(f.scan("出　售　冰　毒")).not.toBe(null);
    expect(f.scan("代开发票")).not.toBe(null);
    expect(f.scan("来找我玩百家乐")).not.toBe(null);
  });

  test("常见正常表达不误伤", async () => {
    const f = await load();
    for (const t of [
      "我在操场跑步",
      "胡萝卜很好吃",
      "招聘兼职客服（正常招聘信息）",
      "这个按摩手法很舒服",
      "银行卡怎么办理",
      "今天天气不错",
      "自拍照发你看看",
      "讨论一下禁赌的宣传",
    ])
      expect(f.scan(t)).toBe(null);
  });

  test("strict 目录默认不含词表（政治/大表类按需自备）", async () => {
    const basic = await loadWordFilter({ mode: "basic", dir: DIR });
    const strict = await loadWordFilter({ mode: "strict", dir: DIR });
    expect(strict.size).toBe(basic.size);
  });
});
