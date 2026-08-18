// Build-time repo indexer. Usage: node scripts/index-repo.mjs owner/repo [ref]
// Clones shallow, extracts symbols, counts real tokens, writes data/<slug>.json
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { encode } from "gpt-tokenizer/encoding/o200k_base";

const MAX_FILES = 400;          // ponytail: caps index JSON ~4MB; split meta/content if it outgrows the function bundle
const MAX_FILE_BYTES = 120_000; // skip generated/minified blobs

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".go", ".rb", ".java"]);
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|vendor|__pycache__|\.next|coverage|test|tests|spec|fixtures|examples?)(\/|$)/;
const SKIP_FILE = /(\.min\.|\.lock$|-lock\.json$|\.d\.ts$|\.test\.|\.spec\.)/;

function walk(dir, root = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (SKIP_DIR.test("/" + rel)) continue;
    if (e.isDirectory()) walk(abs, root, out);
    else if (CODE_EXT.has(path.extname(e.name)) && !SKIP_FILE.test(rel)) {
      const { size } = fs.statSync(abs);
      if (size > 0 && size <= MAX_FILE_BYTES) out.push({ rel, abs, size });
    }
  }
  return out;
}

// ponytail: regex symbol extraction, not tree-sitter. Good enough for a skeleton;
// swap in tree-sitter-wasm if per-language accuracy ever becomes the bottleneck.
const PATTERNS = {
  js: [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/, "function"],
    [/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
    [/^\s*(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/, "type"],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, "function"],
    [/^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/, "method"],
  ],
  py: [
    [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, "function"],
    [/^\s*class\s+([A-Za-z_]\w*)/, "class"],
  ],
  go: [
    [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, "function"],
    [/^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, "type"],
  ],
};
const IMPORT_RE = /(?:^\s*import\s+.*?from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|^\s*from\s+([\w.]+)\s+import|^\s*import\s+([\w./]+))/;

function langOf(rel) {
  const e = path.extname(rel);
  if (e === ".py") return "py";
  if (e === ".go") return "go";
  if (e === ".rb" || e === ".java") return "js"; // close enough for brace langs
  return "js";
}

function extract(content, rel) {
  const pats = PATTERNS[langOf(rel)] ?? PATTERNS.js;
  const lines = content.split("\n");
  const symbols = [], imports = new Set();
  lines.forEach((line, i) => {
    if (line.length > 400) return;
    const im = IMPORT_RE.exec(line);
    if (im) imports.add(im[1] || im[2] || im[3] || im[4]);
    for (const [re, kind] of pats) {
      const m = re.exec(line);
      if (m && m[1] && !["if", "for", "while", "switch", "catch", "return"].includes(m[1])) {
        symbols.push({ name: m[1], kind, line: i + 1, sig: line.trim().slice(0, 160) });
        break;
      }
    }
  });
  return { symbols, imports: [...imports].filter(Boolean) };
}

// Token counts use the o200k_base BPE tokenizer as a stand-in for Claude's.
// Absolute counts are within a few percent; the naive:folded RATIO this tool
// reports is essentially tokenizer-independent, which is the claim that matters.
// ponytail: swap for the count_tokens API if exact Claude numbers ever matter.
const countTokens = (text) => encode(text).length;

const [slug, ref] = process.argv.slice(2);
if (!slug) { console.error("usage: node scripts/index-repo.mjs owner/repo [ref]"); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tfb-"));
console.log(`cloning ${slug} -> ${tmp}`);
execFileSync("git", ["clone", "--depth=1", ...(ref ? ["--branch", ref] : []), `https://github.com/${slug}.git`, tmp], { stdio: "inherit" });
const sha = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"]).toString().trim();

const found = walk(tmp).sort((a, b) => a.rel.localeCompare(b.rel));
const picked = found.slice(0, MAX_FILES);
console.log(`${found.length} code files, indexing ${picked.length}`);

const files = [];
for (const f of picked) {
  const content = fs.readFileSync(f.abs, "utf8");
  const { symbols, imports } = extract(content, f.rel);
  const n = countTokens(content);
  files.push({ path: f.rel, lang: langOf(f.rel), bytes: f.size, tokens: n, symbols, imports, content });
  process.stdout.write(".");
}

const outPath = path.join("data", slug.replace("/", "__") + ".json");
fs.mkdirSync("data", { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({
  slug, sha, indexedAt: new Date().toISOString(), tokenizer: "o200k_base",
  totalFiles: found.length, files,
}));
fs.rmSync(tmp, { recursive: true, force: true });

const total = files.reduce((s, f) => s + f.tokens, 0);
console.log(`\n${outPath}  ${files.length} files  ${total.toLocaleString()} tokens (o200k_base)  $${(total * 5 / 1e6).toFixed(2)}/question naive`);
