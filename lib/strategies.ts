import fs from "node:fs";
import path from "node:path";
import { encode } from "gpt-tokenizer/encoding/o200k_base";

export type Sym = { name: string; kind: string; line: number; sig: string };
export type FileRec = {
  path: string; lang: string; bytes: number; tokens: number;
  symbols: Sym[]; imports: string[]; content: string;
};
export type RepoIndex = {
  slug: string; sha: string; indexedAt: string; tokenizer: string;
  totalFiles: number; files: FileRec[];
};

// Reference pricing: claude-opus-5. The dollar figures this tool reports are a
// projection at Claude rates, which is the benchmark being reproduced. The model
// that actually answers is configured separately (see app/api/ask/route.ts).
export const IN_PER_MTOK = 5;
export const OUT_PER_MTOK = 25;
export const PRICING_MODEL = "claude-opus-5";

export function loadIndex(slug: string): RepoIndex {
  const f = path.join(process.cwd(), "data", slug.replace("/", "__") + ".json");
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

export function listRepos(): string[] {
  const dir = path.join(process.cwd(), "data");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", "").replace("__", "/"));
}

// Per-file counts are precomputed at index time. Only derived strings (the
// skeleton, signature blocks) get encoded here — encoding the full naive context
// on every request would mean BPE-ing 2MB of source per click.
const enc = (s: string) => encode(s).length;

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
 * one thing plain keyword or vector retrieval structurally cannot do.
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

const fullBlock = (f: FileRec) => `--- ${f.path}\n${f.content}`;

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

const cost = (tokens: number) => (tokens * IN_PER_MTOK) / 1e6;

/** Everything, every byte. What you get with no context engine at all. */
export function naive(idx: RepoIndex): Built {
  const context = idx.files.map(fullBlock).join("\n\n");
  const tokens = idx.files.reduce((s, f) => s + f.tokens, 0);
  return {
    strategy: "naive", context, tokens, costUsd: cost(tokens),
    filesFull: idx.files.map((f) => f.path), filesSig: [], filesNames: [],
    note: `All ${idx.files.length} indexed files, complete source.`,
  };
}

/**
 * Top-k keyword retrieval — the standard RAG baseline. Sees only what matched;
 * anything the query does not lexically hit is invisible to the model.
 * ponytail: keyword scoring, not embeddings. Embeddings change recall, not the
 * structural blind spot this comparison exists to show.
 */
export function retrieval(idx: RepoIndex, query: string, budget = 40_000): Built {
  const ts = terms(query);
  const ranked = idx.files
    .map((f) => ({ f, s: scoreFile(f, ts) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  const picked: FileRec[] = [];
  let tokens = 0;
  for (const { f } of ranked) {
    if (tokens + f.tokens > budget) continue;
    picked.push(f); tokens += f.tokens;
  }
  return {
    strategy: "retrieval", context: picked.map(fullBlock).join("\n\n"),
    tokens, costUsd: cost(tokens),
    filesFull: picked.map((f) => f.path), filesSig: [], filesNames: [],
    note: `Top-k by keyword score. ${idx.files.length - picked.length} files invisible to the model.`,
  };
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

  // The repo-wide name skeleton is charged first: nothing is ever fully
  // invisible, and whatever budget is left goes depth-first on the top matches.
  const skeleton = ranked.map(namesLine).join("\n");
  let tokens = enc(skeleton);

  for (const f of ranked) {
    const s = scores.get(f.path) ?? 0;
    if (s > 0 && tokens + f.tokens <= budget) { full.push(f); tokens += f.tokens; continue; }
    const sb = enc(sigBlock(f));
    if (s > 0 && tokens + sb <= budget) { sig.push(f); tokens += sb; continue; }
    names.push(f);
  }

  const context = [
    `# Repository map (${idx.slug} @ ${idx.sha.slice(0, 7)}) — every file, symbol names only`,
    skeleton,
    full.length ? `\n# Full source — files the query needs\n${full.map(fullBlock).join("\n\n")}` : "",
    sig.length ? `\n# Signatures only — adjacent files\n${sig.map(sigBlock).join("\n\n")}` : "",
  ].filter(Boolean).join("\n");

  return {
    strategy: "folded", context, tokens, costUsd: cost(tokens),
    filesFull: full.map((f) => f.path),
    filesSig: sig.map((f) => f.path),
    filesNames: names.map((f) => f.path),
    note: `${full.length} full, ${sig.length} signatures, ${names.length} name-only. Nothing dropped.`,
  };
}

export const STRATEGIES = { naive, retrieval, folded };
