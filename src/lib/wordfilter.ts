/**
 * 违禁词过滤：Trie 扫描 + 文本归一化。
 *
 * 归一化先行是关键——只做子串匹配会被「全角、空格、标点、零宽字符」轻易绕过；
 * 因此匹配在归一化后的文本上进行（去符号与空白、全角转半角、英文小写），
 * 词表条目同样归一化后入树，两侧口径一致。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type BannedWordsMode = "off" | "basic" | "strict";

export interface WordFilter {
  /** 命中返回命中的词（归一化口径，仅用于服务端日志），未命中返回 null。 */
  scan(text: string): string | null;
  /** 已入库词条数（已按词长下限过滤）。 */
  size: number;
}

/** 词长下限：单字词（如「屌」）在中文里极易误伤，默认丢弃。 */
const MIN_WORD_LEN = 2;

/**
 * 归一化：NFKC（全角转半角）→ 小写 → 去零宽/软连字符 → 仅保留字母与数字
 * （汉字属字母类，标点、空白、emoji 一并剔除）。
 */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200b-\u200f\ufeff\u00ad]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

type TrieNode = { next: Map<string, TrieNode>; word?: string };

/** 在 code point 维度做朴素子串搜索，返回所有覆盖区间（闭开区间）。 */
function findRanges(hay: readonly string[], needle: readonly string[]) {
  const ranges: Array<[number, number]> = [];
  if (!needle.length || needle.length > hay.length) return ranges;
  outer: for (let s = 0; s + needle.length <= hay.length; s++) {
    for (let k = 0; k < needle.length; k++) {
      if (hay[s + k] !== needle[k]) continue outer;
    }
    ranges.push([s, s + needle.length]);
  }
  return ranges;
}

export function buildWordFilter(
  words: readonly string[],
  allow: readonly string[] = [],
  minLen: number = MIN_WORD_LEN,
): WordFilter {
  const root: TrieNode = { next: new Map() };
  const seen = new Set<string>();
  for (const raw of words) {
    const w = normalizeText(raw ?? "");
    if (Array.from(w).length < minLen || seen.has(w)) continue;
    seen.add(w);
    let node = root;
    for (const ch of w) {
      let nx = node.next.get(ch);
      if (!nx) {
        nx = { next: new Map() };
        node.next.set(ch, nx);
      }
      node = nx;
    }
    node.word = w;
  }
  const allowWords = allow
    .map((a) => normalizeText(a ?? ""))
    .filter((a) => a.length > 0);
  const size = seen.size;

  const allowRanges = (chars: readonly string[]) =>
    allowWords.flatMap((a) => findRanges(chars, Array.from(a)));

  return {
    size,
    scan(text: string): string | null {
      const chars = Array.from(normalizeText(text));
      if (!chars.length || !size) return null;
      const ranges = allowWords.length > 0 ? allowRanges(chars) : [];
      const covered = (from: number, to: number) =>
        ranges.some(([s, e]) => s <= from && to <= e);
      for (let i = 0; i < chars.length; i++) {
        let node = root;
        for (let j = i; j < chars.length; j++) {
          const nx = node.next.get(chars[j]);
          if (!nx) break;
          node = nx;
          // 命中后被白名单完整覆盖时继续尝试更长的词，避免「合法化」类豁免吞掉更长的违禁词
          if (node.word && !covered(i, j + 1)) return node.word;
        }
      }
      return null;
    },
  };
}

async function readWordDir(dir: string): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    // 词库目录缺失（如部署时未把 data/** 打进函数）不致命：退化为仅显式词，
    // 但必须留痕（error 级），否则「静默失去过滤能力」很难被发现。
    console.error(`[wordfilter] 词库目录不可读，已跳过：${dir}`);
    return [];
  }
  const out: string[] = [];
  for (const f of files) {
    if (!f.endsWith(".txt")) continue;
    try {
      const txt = await readFile(join(dir, f), "utf8");
      for (const line of txt.split(/\r?\n/)) {
        const w = line.trim();
        if (w && !w.startsWith("#")) out.push(w);
      }
    } catch {
      // 单个词库文件读取失败不影响其余文件
    }
  }
  return out;
}

/**
 * 按模式装载词库：
 * - off    不加载内置词库，仅用显式词（BANNED_WORDS 等），等同旧行为
 * - basic  加载 <dir>/basic/*.txt（精选高精度词表）
 * - strict basic + <dir>/strict/*.txt（运营自选的扩展词表，如政治/暴恐/大表）
 */
export async function loadWordFilter(opts: {
  mode: BannedWordsMode;
  dir: string;
  extra?: readonly string[];
  allow?: readonly string[];
}): Promise<WordFilter> {
  const words: string[] = [...(opts.extra ?? [])];
  if (opts.mode !== "off") {
    words.push(...(await readWordDir(join(opts.dir, "basic"))));
    if (opts.mode === "strict")
      words.push(...(await readWordDir(join(opts.dir, "strict"))));
  }
  return buildWordFilter(words, opts.allow ?? []);
}
