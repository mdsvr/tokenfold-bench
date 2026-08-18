import { NextRequest } from "next/server";
import { loadIndex, naive, retrieval, folded, PRICING_MODEL } from "@/lib/strategies";

export const maxDuration = 300;

// The answering model is deliberately separate from the pricing model. Token
// counts and dollar figures in the UI are a claude-opus-5 projection (the
// benchmark being reproduced); the answer itself is generated here, on a free
// tier, so the demo can be clicked freely without a per-click bill.
const ANSWER_MODEL = "gemini-3.7-flash";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse";

const BUILDERS = { naive, retrieval, folded } as const;
type Name = keyof typeof BUILDERS;

const SYSTEM = `You answer questions about a codebase using only the context provided.
The context may be partial: some files appear as full source, some as signatures only,
some as just a path and symbol names. Answer from what you can see, cite file paths, and
if the context is too thin to answer, say exactly which file you would need to read next.`;

export async function POST(req: NextRequest) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return Response.json(
      { error: "GEMINI_API_KEY is not set on the server." },
      { status: 503 },
    );
  }

  const { repo, query, strategy } = await req.json();
  const build = BUILDERS[strategy as Name];
  if (!build) return Response.json({ error: "unknown strategy" }, { status: 400 });

  const idx = loadIndex(repo);
  const built = strategy === "naive" ? naive(idx) : build(idx, query);

  const upstream = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      model: ANSWER_MODEL,
      // System text is folded into the input rather than sent as a separate
      // field — one less unverified API field, same effect.
      input: `${SYSTEM}\n\n${built.context}\n\n---\nQuestion: ${query}`,
      stream: true,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return Response.json(
      {
        error: `${ANSWER_MODEL} returned ${upstream.status}`,
        detail: detail.slice(0, 600),
        hint:
          upstream.status === 429
            ? "Free-tier rate limit. The naive context is ~540k tokens per call, which burns the per-minute quota in one click."
            : undefined,
      },
      { status: 502 },
    );
  }

  const encoder = new TextEncoder();
  const out = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(encoder.encode(JSON.stringify(o) + "\n"));
      const reader = upstream.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let sawText = false;
      let failed = false;
      const samples: string[] = [];

      send({
        type: "meta",
        strategy,
        tokens: built.tokens,
        note: built.note,
        answerModel: ANSWER_MODEL,
        pricingModel: PRICING_MODEL,
      });

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            if (samples.length < 3) samples.push(payload.slice(0, 300));

            let ev: Record<string, unknown>;
            try {
              ev = JSON.parse(payload);
            } catch {
              continue;
            }

            // Quota and safety failures arrive as an in-stream error object with
            // HTTP 200, not as a failed response. Report them cleanly instead of
            // letting the raw payload fall through to the sample dump.
            const upstreamErr = ev.error as { message?: string } | undefined;
            if (upstreamErr) {
              failed = true;
              const msg = upstreamErr.message ?? "upstream error";
              send({
                type: "error",
                error: /quota|rate limit/i.test(msg)
                  ? "Gemini free-tier quota exhausted. It resets shortly — the naive strategy burns it fastest."
                  : msg.slice(0, 300),
              });
              continue;
            }

            const delta = ev.delta as { type?: string; text?: string } | undefined;
            if (ev.event_type === "step.delta" && delta?.type === "text" && delta.text) {
              sawText = true;
              send({ type: "text", text: delta.text });
            }
            if (ev.event_type === "interaction.completed") {
              const usage = (ev.interaction as { usage?: { total_tokens?: number } } | undefined)?.usage;
              send({ type: "done", answerTokens: usage?.total_tokens ?? null });
            }
          }
        }

        // If the event shape ever drifts, surface the raw payload instead of
        // silently streaming nothing — turns a mystery into a 30-second fix.
        if (!sawText && !failed) {
          send({
            type: "error",
            error: "No text deltas parsed from the upstream stream.",
            samples,
          });
        }
      } catch (e) {
        send({ type: "error", error: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(out, { headers: { "Content-Type": "application/x-ndjson" } });
}
