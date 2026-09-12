/** Matches on normalized text so full-width, spacing and zero-width tricks cannot bypass it. */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type BannedWordsMode = "off" | "basic" | "strict";

export interface WordFilter {
  /** Returns the matched word (normalized form), or null. */
  scan(text: string): string | null;
  size: number;
}

/** Single-CJK-char words cause false positives, so they are dropped by default. */
const MIN_WORD_LEN = 2;

/** NFKC + lowercase + strip zero-width, keeping letters/digits; dictionary entries too. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200b-\u200f\ufeff\u00ad]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

type TrieNode = { next: Map<string, TrieNode>; word?: string };

/** Naive code-point search returning [start, end) ranges. */
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
          // A covered hit means an allow entry matched: keep looking for a longer word.
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
    // A missing wordlist dir is non-fatal (explicit words still apply) but must be logged loudly.
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
      // One unreadable file must not drop the others.
    }
  }
  return out;
}

/** off = explicit words only; basic/strict = <dir>/basic plus <dir>/strict for strict. */
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
