# TokenFold Bench

Three ways to feed a repository to a model, measured on the same question.

| strategy | what it does | on django/django |
|---|---|---|
| naive | every file, every byte | 540,595 tok · $2.70 |
| retrieval | top-k keyword, standard RAG baseline | 40,032 tok · $0.20 · **389 files invisible** |
| folded | tiered resolution: names for all, signatures nearby, full source where needed | 40,091 tok · $0.20 · **nothing dropped** |

The point is not naive vs. the rest. It is retrieval vs. folded **at an identical token
budget**: retrieval buys depth by going blind, folded keeps every file visible at some
resolution and spends its remaining budget on depth.

## Run

```bash
npm install
cp .env.example .env.local        # add your key
node scripts/index-repo.mjs django/django   # writes data/django__django.json
node scripts/check.ts             # self-check on the strategies
npm run dev
```

Indexing is build-time on purpose: repos are cloned shallow with `git clone --depth=1`,
symbol-extracted, token-counted once, and committed as JSON. Nothing is indexed at
request time, so the demo cannot fail while someone is clicking it.

Without `ANTHROPIC_API_KEY` the indexer falls back to a char/3.5 estimate and the UI
labels the counts as estimated. With a key, counts come from the `count_tokens` API.
