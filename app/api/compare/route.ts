import { NextRequest, NextResponse } from "next/server";
import { loadIndex, listRepos, naive, retrieval, folded } from "@/lib/strategies";

export const maxDuration = 60;

export async function GET() {
  return NextResponse.json({ repos: listRepos() });
}

/** Free + instant: builds all three contexts and reports stats. No model call. */
export async function POST(req: NextRequest) {
  const { repo, query } = await req.json();
  if (!repo || !query?.trim()) {
    return NextResponse.json({ error: "repo and query required" }, { status: 400 });
  }
  let idx;
  try {
    idx = loadIndex(repo);
  } catch {
    return NextResponse.json({ error: `no index for ${repo}` }, { status: 404 });
  }

  const strip = (b: ReturnType<typeof naive>) => {
    const { context, ...rest } = b; // never ship 540K tokens of source to the browser
    void context;
    return rest;
  };

  return NextResponse.json({
    repo: idx.slug,
    sha: idx.sha.slice(0, 7),
    indexedFiles: idx.files.length,
    totalFiles: idx.totalFiles,
    exactTokens: idx.exactTokens,
    results: [naive(idx), retrieval(idx, query), folded(idx, query)].map(strip),
  });
}
