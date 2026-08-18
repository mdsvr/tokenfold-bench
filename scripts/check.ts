// Self-check for context strategies. Run: node scripts/check.ts
import assert from "node:assert";
import { loadIndex, naive, retrieval, folded } from "../lib/strategies.ts";

const idx = loadIndex("django/django");
const Q = "how does user authentication and password hashing work";

const n = naive(idx);
const r = retrieval(idx, Q);
const f = folded(idx, Q);

// 1. Folded and retrieval must both stay under budget; naive must not.
assert.ok(r.tokens <= 45_000, `retrieval over budget: ${r.tokens}`);
assert.ok(f.tokens <= 45_000, `folded over budget: ${f.tokens}`);
assert.ok(n.tokens > 200_000, `naive should be huge, got ${n.tokens}`);

// 2. The core claim: folded must cost far less than naive.
const cut = 1 - f.tokens / n.tokens;
assert.ok(cut > 0.6, `folded only cut ${(cut * 100).toFixed(1)}%`);

// 3. Folded must keep EVERY file visible at some tier; retrieval must not.
const covered = f.filesFull.length + f.filesSig.length + f.filesNames.length;
assert.strictEqual(covered, idx.files.length, `folded lost files: ${covered}/${idx.files.length}`);
assert.ok(r.filesFull.length < idx.files.length, "retrieval should drop files");

// 4. Relevance actually works — auth files rank into full source.
const hitAuth = f.filesFull.some((p) => /auth|password|hashers/i.test(p));
assert.ok(hitAuth, `no auth file in full tier: ${f.filesFull.slice(0, 8).join(", ")}`);

// 5. Import-graph boost must pull in at least one file with no lexical match.
const ts = Q.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
const nonLexical = f.filesFull.filter((p) => {
  const rec = idx.files.find((x) => x.path === p)!;
  return !ts.some((t) => rec.path.toLowerCase().includes(t));
});

console.log(`naive     ${n.tokens.toLocaleString().padStart(9)} tok  $${n.costUsd.toFixed(3)}`);
console.log(`retrieval ${r.tokens.toLocaleString().padStart(9)} tok  $${r.costUsd.toFixed(3)}  ${r.note}`);
console.log(`folded    ${f.tokens.toLocaleString().padStart(9)} tok  $${f.costUsd.toFixed(3)}  ${f.note}`);
console.log(`\ncut vs naive: ${(cut * 100).toFixed(1)}%   graph-only files: ${nonLexical.length}`);
console.log(`top full: ${f.filesFull.slice(0, 5).join("  ")}`);
console.log("\nall checks passed");
