"use client";

import { useEffect, useState } from "react";

type Result = {
  strategy: string; tokens: number; costUsd: number;
  filesFull: string[]; filesSig: string[]; filesNames: string[]; note: string;
};
type Compare = {
  repo: string; sha: string; indexedFiles: number; totalFiles: number;
  exactTokens: boolean; results: Result[];
};

const LABEL: Record<string, string> = {
  naive: "Naive — send everything",
  retrieval: "Retrieval — top-k keyword",
  folded: "Folded — tiered resolution",
};
const BLURB: Record<string, string> = {
  naive: "No context engine. Every file, every byte.",
  retrieval: "The standard RAG baseline. Cheap, but blind to whatever did not match.",
  folded: "Same budget as retrieval. Nothing ever fully disappears.",
};
const TIER = {
  full: { c: "bg-emerald-400", t: "full source" },
  sig: { c: "bg-sky-400", t: "signatures" },
  name: { c: "bg-slate-500", t: "names only" },
  gone: { c: "bg-neutral-800", t: "invisible" },
};

const usd = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export default function Page() {
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState("");
  const [query, setQuery] = useState("how does user authentication and password hashing work");
  const [data, setData] = useState<Compare | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [answer, setAnswer] = useState<{
    strategy: string; text: string; usage?: { costUsd: number; input: number };
  } | null>(null);

  useEffect(() => {
    fetch("/api/compare").then((r) => r.json()).then((d) => {
      setRepos(d.repos ?? []);
      setRepo((d.repos ?? [])[0] ?? "");
    });
  }, []);

  async function compare() {
    if (!repo || !query.trim()) return;
    setBusy(true); setErr(""); setAnswer(null);
    try {
      const r = await fetch("/api/compare", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, query }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "compare failed");
      setData(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function ask(strategy: string, costUsd: number) {
    const ok =
      strategy !== "naive" ||
      window.confirm(`Naive context is ~${usd(costUsd)} of input tokens for this one question. Run it?`);
    if (!ok) return;

    setAnswer({ strategy, text: "" });
    const r = await fetch("/api/ask", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, query, strategy, confirm: true }),
    });
    if (!r.ok || !r.body) {
      const d = await r.json().catch(() => ({ error: r.statusText }));
      setAnswer({ strategy, text: `⚠ ${d.error ?? "request failed"}` });
      return;
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === "text") setAnswer((a) => (a ? { ...a, text: a.text + ev.text } : a));
        if (ev.type === "done") setAnswer((a) => (a ? { ...a, usage: ev.usage } : a));
        if (ev.type === "error") setAnswer((a) => (a ? { ...a, text: `${a.text}\n⚠ ${ev.error}` } : a));
      }
    }
  }

  const universe = data?.results.find((r) => r.strategy === "naive")?.filesFull ?? [];
  const maxTok = Math.max(...(data?.results.map((r) => r.tokens) ?? [1]));

  return (
    <main className="min-h-screen bg-neutral-950 px-6 py-10 font-sans text-neutral-200">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-white">TokenFold Bench</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-400">
            Three ways to feed a repository to a model, measured on the same question.
            The interesting comparison is not naive vs. the rest — it is{" "}
            <span className="text-sky-300">retrieval vs. folded at an identical token budget</span>.
          </p>
        </header>

        <div className="flex flex-wrap gap-3">
          <select
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm"
          >
            {repos.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && compare()}
            placeholder="ask something about this codebase"
            className="min-w-[22rem] flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-sky-600"
          />
          <button
            onClick={compare}
            disabled={busy}
            className="rounded-md bg-sky-600 px-5 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
          >
            {busy ? "building…" : "Compare"}
          </button>
        </div>

        {err && <p className="mt-4 text-sm text-red-400">{err}</p>}

        {data && (
          <>
            <p className="mt-4 text-xs text-neutral-500">
              {data.repo} @ {data.sha} · {data.indexedFiles} of {data.totalFiles} code files indexed ·{" "}
              {data.exactTokens
                ? "token counts exact (count_tokens API)"
                : "token counts estimated — set ANTHROPIC_API_KEY and re-index for exact"}
            </p>

            <section className="mt-6 grid gap-4 md:grid-cols-3">
              {data.results.map((r) => {
                const shown = new Set([...r.filesFull, ...r.filesSig, ...r.filesNames]);
                const blind = universe.filter((f) => !shown.has(f)).length;
                return (
                  <article key={r.strategy} className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
                    <h2 className="text-sm font-semibold text-white">{LABEL[r.strategy]}</h2>
                    <p className="mt-1 text-xs leading-relaxed text-neutral-500">{BLURB[r.strategy]}</p>

                    <div className="mt-4 flex items-baseline gap-2">
                      <span className="font-mono text-2xl text-white">{r.tokens.toLocaleString()}</span>
                      <span className="text-xs text-neutral-500">tokens</span>
                    </div>
                    <div className="mt-1 font-mono text-sm text-amber-300">{usd(r.costUsd)} / question</div>

                    <div className="mt-3 h-1.5 overflow-hidden rounded bg-neutral-800">
                      <div
                        className={r.strategy === "naive" ? "h-full bg-red-500" : "h-full bg-emerald-500"}
                        style={{ width: `${(r.tokens / maxTok) * 100}%` }}
                      />
                    </div>

                    <dl className="mt-4 space-y-1 text-xs text-neutral-400">
                      <div className="flex justify-between">
                        <dt>full source</dt>
                        <dd className="font-mono text-emerald-400">{r.filesFull.length}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt>signatures</dt>
                        <dd className="font-mono text-sky-400">{r.filesSig.length}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt>names only</dt>
                        <dd className="font-mono text-slate-400">{r.filesNames.length}</dd>
                      </div>
                      <div className="flex justify-between border-t border-neutral-800 pt-1">
                        <dt className={blind ? "text-red-400" : "text-neutral-500"}>invisible</dt>
                        <dd className={`font-mono ${blind ? "text-red-400" : "text-neutral-500"}`}>{blind}</dd>
                      </div>
                    </dl>

                    <button
                      onClick={() => ask(r.strategy, r.costUsd)}
                      className="mt-4 w-full rounded border border-neutral-700 py-1.5 text-xs hover:border-sky-600 hover:text-sky-300"
                    >
                      Answer with this context
                    </button>
                  </article>
                );
              })}
            </section>

            <section className="mt-8">
              <h2 className="text-sm font-semibold text-white">What the model can actually see</h2>
              <p className="mt-1 text-xs text-neutral-500">
                One tile per indexed file, same order in every row. Dark grey means the model never learns that file exists.
              </p>
              <div className="mt-4 space-y-4">
                {data.results.map((r) => {
                  const full = new Set(r.filesFull);
                  const sig = new Set(r.filesSig);
                  const nm = new Set(r.filesNames);
                  return (
                    <div key={r.strategy}>
                      <div className="mb-1 flex items-baseline justify-between">
                        <span className="text-xs font-medium text-neutral-300">{r.strategy}</span>
                        <span className="text-[11px] text-neutral-500">{r.note}</span>
                      </div>
                      <div className="flex flex-wrap gap-[2px]">
                        {universe.map((f) => {
                          const tier = full.has(f) ? TIER.full : sig.has(f) ? TIER.sig : nm.has(f) ? TIER.name : TIER.gone;
                          return <span key={f} title={`${f} — ${tier.t}`} className={`h-2.5 w-2.5 rounded-[1px] ${tier.c}`} />;
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 flex gap-4 text-[11px] text-neutral-500">
                {Object.values(TIER).map((t) => (
                  <span key={t.t} className="flex items-center gap-1.5">
                    <span className={`h-2.5 w-2.5 rounded-[1px] ${t.c}`} />
                    {t.t}
                  </span>
                ))}
              </div>
            </section>
          </>
        )}

        {answer && (
          <section className="mt-8 rounded-lg border border-neutral-800 bg-neutral-900/60 p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-white">Answer · {answer.strategy}</h2>
              {answer.usage && (
                <span className="font-mono text-xs text-amber-300">
                  {answer.usage.input.toLocaleString()} in · {usd(answer.usage.costUsd)} actual
                </span>
              )}
            </div>
            <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed text-neutral-300">
              {answer.text || "…"}
            </pre>
          </section>
        )}
      </div>
    </main>
  );
}
