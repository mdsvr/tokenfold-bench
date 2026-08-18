import fs from "node:fs";
import path from "node:path";

export type Sym = { name: string; kind: string; line: number; sig: string };
export type FileRec = {
  path: string; lang: string; bytes: number; tokens: number;
  symbols: Sym[]; imports: string[]; content: string;
};
export type RepoIndex = {
  slug: string; sha: string; indexedAt: string; exactTokens: boolean;
  totalFiles: number; files: FileRec[];
};

export const IN_PER_MTOK = 5;   // claude-opus-5 input $/1M
export const OUT_PER_MTOK = 25;

export function loadIndex(slug: string): RepoIndex {
  const f = path.join(process.cwd(), "data", slug.replace("/", "__") + ".json");
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

export function listRepos(): string[] {
  const dir = path.join(process.cwd(), "data");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", "").replace("__", "/"));
}

// tokens ~ chars/3.5. Only used to size assembled context; per-file numbers in the
// index are exact when the indexer ran with an API key.
const est = (s: string) => Math.ceil(s.length / 3.5);

const STOP = new Set(["the","a","an","is","are","how","what","where","does","do","in","of","to","and","for","this","it","i","on","with"]);
const terms = (q: string) =>
  q.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 2 && !STOP.has(t));

/** Relevance score for one file against the query terms. */
function scoreFile(f: FileRec, ts: string[]): number {
  const lowPath = f.path.toLowerCase();
  const lowContent = f.content.toLowerCase();
  let s = 0;
  for (const t of ts) {
    if (lowPath.includes(t)) s += 12;
    for (const sym of f.symbols) if (sym.name.toLowerCase().includes(t)) s += 8;
    const hits = lowContent.split(t).length - 1;
    if (hits) s += Math.min(6, Math.log2(hits + 1) * 2);
  }
  return s;
}

/**
 * Dependency-aware boost: a file imported by (or importing) a high scorer is
 * probably relevant even when it never mentions the query terms. This is the
 * one thing plain keyword/vector retrieval structurally cannot do.
 */
function propagate(files: FileRec[], scores: Map<string, number>): Map<string, number> {
  const byStem = new Map<string, string>();
  for (const f of files) {
    byStem.set(f.path.replace(/\.[^.]+$/, ""), f.path);
    byStem.set(f.path.split("/").pop()!.replace(/\.[^.]+$/, ""), f.path);
  }
  const out = new Map(scores);
  for (const f of files) {
    const base = scores.get(f.path) ?? 0;
    if (base <= 0) continue;
    for (const imp of f.imports) {
      const stem = imp.replace(/^[./]+/, "").split("/").pop() ?? "";
      const target = byStem.get(stem);
      if (target && target !== f.path) {
        out.set(target, (out.get(target) ?? 0) + base * 0.35);
      }
    }
  }
  return out;
}

const namesLine = (f: FileRec) =>
  `${f.path}: ${[...new Set(f.symbols.map((s) => s.name))].slice(0, 24).join(", ")}`;

const sigBlock = (f: FileRec) =>
  `--- ${f.path}\n${f.symbols.slice(0, 40).map((s) => `  ${s.line}: ${s.sig}`).join("\n")}`;

const fullBlock = (f: FileRec) =>
  `--- ${f.path}\n${f.content}`;

export type Built = {
  strategy: string;
  context: string;
  tokens: number;
  costUsd: number;
  filesFull: string[];
  filesSig: string[];
  filesNames: string[];
  note: string;
};

const finish = (strategy: string, context: string, parts: Omit<Built, "strategy"|"context"|"tokens"|"costUsd">): Built => {
  const tokens = est(context);
  return { strategy, context, tokens, costUsd: (tokens * IN_PER_MTOK) / 1e6, ...parts };
};

/** Everything, every byte. What you get with no context engine at all. */
export function naive(idx: RepoIndex): Built {
  const ctx = idx.files.map(fullBlock).join("\n\n");
  return finish("naive", ctx, {
    filesFull: idx.files.map((f) => f.path), filesSig: [], filesNames: [],
    note: `All ${idx.files.length} indexed files, complete source.`,
  });
}

/**
 * Top-k keyword retrieval — the standard RAG baseline. Sees only what matched;
 * anything the query does not lexically hit is invisible to the model.
 * ponytail: keyword scoring, not embeddings. Embeddings change recall, not the
 * structural blind spot this comparison exists to show. Swap in if recall is the bottleneck.
 */
export function retrieval(idx: RepoIndex, query: string, budget = 40_000): Built {
  const ts = terms(query);
  const ranked = idx.files
    .map((f) => ({ f, s: scoreFile(f, ts) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  const picked: FileRec[] = [];
  let used = 0;
  for (const { f } of ranked) {
    if (used + f.tokens > budget) continue;
    picked.push(f); used += f.tokens;
  }
  const ctx = picked.map(fullBlock).join("\n\n");
  return finish("retrieval", ctx, {
    filesFull: picked.map((f) => f.path), filesSig: [], filesNames: [],
    note: `Top-k by keyword score. ${idx.files.length - picked.length} files invisible to the model.`,
  });
}

/**
 * Folded: every file stays visible at some resolution. Names for the whole repo
 * (structural awareness), signatures for the neighbourhood, full source only for
 * what the query actually needs.
 */
export function folded(idx: RepoIndex, query: string, budget = 40_000): Built {
  const ts = terms(query);
  const base = new Map(idx.files.map((f) => [f.path, scoreFile(f, ts)] as const));
  const scores = propagate(idx.files, base);
  const ranked = [...idx.files].sort(
    (a, b) => (scores.get(b.path) ?? 0) - (scores.get(a.path) ?? 0),
  );

  const full: FileRec[] = [], sig: FileRec[] = [], names: FileRec[] = [];
  let used = 0;

  // Reserve ~40% of budget for the repo-wide name skeleton so nothing is ever
  // fully invisible; spend the rest depth-first on the top matches.
  const skeleton = ranked.map(namesLine).join("\n");
  const skelTokens = est(skeleton);
  used += skelTokens;

  for (const f of ranked) {
    const s = scores.get(f.path) ?? 0;
    if (s > 0 && used + f.tokens <= budget) { full.push(f); used += f.tokens; continue; }
    const sb = est(sigBlock(f));
    if (s > 0 && used + sb <= budget) { sig.push(f); used += sb; continue; }
    names.push(f);
  }

  const ctx = [
    `# Repository map (${idx.slug} @ ${idx.sha.slice(0, 7)}) — every file, symbol names only`,
    skeleton,
    full.length ? `\n# Full source — files the query needs\n${full.map(fullBlock).join("\n\n")}` : "",
    sig.length ? `\n# Signatures only — adjacent files\n${sig.map(sigBlock).join("\n\n")}` : "",
  ].filter(Boolean).join("\n");

  return finish("folded", ctx, {
    filesFull: full.map((f) => f.path),
    filesSig: sig.map((f) => f.path),
    filesNames: names.map((f) => f.path),
    note: `${full.length} full, ${sig.length} signatures, ${names.length} name-only. Nothing dropped.`,
  });
}

export const STRATEGIES = { naive, retrieval, folded };
