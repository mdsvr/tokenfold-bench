import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { loadIndex, naive, retrieval, folded, IN_PER_MTOK, OUT_PER_MTOK } from "@/lib/strategies";

export const maxDuration = 300;

const BUILDERS = { naive, retrieval, folded } as const;
type Name = keyof typeof BUILDERS;

const SYSTEM = `You answer questions about a codebase using only the context provided.
The context may be partial: some files appear as full source, some as signatures only,
some as just a path and symbol names. Answer from what you can see, cite file paths,
and if the context is too thin to answer, say exactly which file you would need to read next.`;

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "ANTHROPIC_API_KEY is not set on the server." }, { status: 503 });
  }
  const { repo, query, strategy, confirm } = await req.json();
  const build = BUILDERS[strategy as Name];
  if (!build) return Response.json({ error: "unknown strategy" }, { status: 400 });

  const idx = loadIndex(repo);
  const built = strategy === "naive" ? naive(idx) : build(idx, query);

  // Naive on a real repo is ~$2.70 a click. Never spend that without an explicit ok.
  if (strategy === "naive" && !confirm) {
    return Response.json(
      { needsConfirm: true, tokens: built.tokens, costUsd: built.costUsd },
      { status: 402 },
    );
  }

  const client = new Anthropic();
  const stream = client.messages.stream({
    model: "claude-opus-5",
    max_tokens: 8000,
    system: SYSTEM,
    messages: [{ role: "user", content: `${built.context}\n\n---\nQuestion: ${query}` }],
  });

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
      try {
        send({ type: "meta", strategy, tokens: built.tokens, note: built.note });
        for await (const ev of stream) {
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            send({ type: "text", text: ev.delta.text });
          }
        }
        const final = await stream.finalMessage();
        const u = final.usage;
        send({
          type: "done",
          usage: {
            input: u.input_tokens,
            output: u.output_tokens,
            costUsd: (u.input_tokens * IN_PER_MTOK + u.output_tokens * OUT_PER_MTOK) / 1e6,
          },
        });
      } catch (e) {
        send({ type: "error", error: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
}
